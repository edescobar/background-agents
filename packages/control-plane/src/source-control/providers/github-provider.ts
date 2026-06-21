/**
 * GitHub source control provider implementation.
 *
 * Implements the SourceControlProvider interface for GitHub,
 * wrapping existing GitHub API functions.
 */

import type { InstallationRepository } from "@open-inspect/shared";
import type {
  SourceControlProvider,
  SourceControlAuthContext,
  GetRepositoryConfig,
  RepositoryAccessResult,
  RepositoryInfo,
  CreatePullRequestConfig,
  CreatePullRequestResult,
  BuildManualPullRequestUrlConfig,
  BuildGitPushSpecConfig,
  GitPushSpec,
  GitPushAuthContext,
  CredentialHelperAuth,
} from "../types";
import { SourceControlProviderError } from "../errors";
import {
  getCachedInstallationToken,
  getCachedInstallationTokenWithExpiry,
  getInstallationRepository,
  listInstallationRepositories,
  listRepositoryBranches,
  fetchWithTimeout,
} from "../../auth/github-app";
import type { GitHubProviderConfig } from "./types";
import { USER_AGENT, GITHUB_API_BASE } from "./constants";

/** Extract HTTP status from upstream errors (GitHubHttpError has a .status property). */
function extractHttpStatus(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
    return error.status;
  }
  return undefined;
}

/**
 * GitHub implementation of SourceControlProvider.
 */
export class GitHubSourceControlProvider implements SourceControlProvider {
  readonly name = "github";

  private readonly appConfigs: GitHubProviderConfig["appConfigs"];
  private readonly cacheStore?: GitHubProviderConfig["cacheStore"];
  private readonly userAgent: string;

  constructor(config: GitHubProviderConfig = {}) {
    this.appConfigs = config.appConfigs;
    this.cacheStore = config.cacheStore;
    this.userAgent = config.userAgent || USER_AGENT;
  }

  /**
   * Get repository information from GitHub API.
   */
  async getRepository(
    auth: SourceControlAuthContext,
    config: GetRepositoryConfig
  ): Promise<RepositoryInfo> {
    const response = await fetchWithTimeout(
      `${GITHUB_API_BASE}/repos/${config.owner}/${config.name}`,
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
          Authorization: `Bearer ${auth.token}`,
          "User-Agent": this.userAgent,
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw SourceControlProviderError.fromFetchError(
        `Failed to get repository: ${response.status} ${error}`,
        new Error(error),
        response.status
      );
    }

    const data = (await response.json()) as {
      id: number;
      name: string;
      full_name: string;
      default_branch: string;
      private: boolean;
      owner: { login: string };
    };

    return {
      owner: data.owner.login,
      name: data.name,
      fullName: data.full_name,
      defaultBranch: data.default_branch,
      isPrivate: data.private,
      providerRepoId: data.id,
    };
  }

  /**
   * Create a pull request on GitHub.
   */
  async createPullRequest(
    auth: SourceControlAuthContext,
    config: CreatePullRequestConfig
  ): Promise<CreatePullRequestResult> {
    const requestBody: Record<string, unknown> = {
      title: config.title,
      body: config.body,
      head: config.sourceBranch,
      base: config.targetBranch,
    };

    // Add draft flag if requested and supported
    if (config.draft) {
      requestBody.draft = true;
    }

    const response = await fetchWithTimeout(
      `${GITHUB_API_BASE}/repos/${config.repository.owner}/${config.repository.name}/pulls`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github.v3+json",
          Authorization: `Bearer ${auth.token}`,
          "User-Agent": this.userAgent,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw SourceControlProviderError.fromFetchError(
        `Failed to create PR: ${response.status} ${error}`,
        new Error(error),
        response.status
      );
    }

    const data = (await response.json()) as {
      number: number;
      html_url: string;
      url: string;
      state: string;
      draft: boolean;
      merged: boolean;
      head: { ref: string };
      base: { ref: string };
    };

    // Map GitHub state to our state type
    // GitHub uses state: "closed" + merged: true for merged PRs
    let state: CreatePullRequestResult["state"];
    if (data.draft) {
      state = "draft";
    } else if (data.merged) {
      state = "merged";
    } else if (data.state === "open") {
      state = "open";
    } else if (data.state === "closed") {
      state = "closed";
    } else {
      state = "open"; // Default to open for unknown states
    }

    const result: CreatePullRequestResult = {
      id: data.number,
      webUrl: data.html_url,
      apiUrl: data.url,
      state,
      sourceBranch: data.head.ref,
      targetBranch: data.base.ref,
    };

    // Add labels if requested
    if (config.labels && config.labels.length > 0) {
      await this.addLabels(
        auth.token,
        config.repository.owner,
        config.repository.name,
        data.number,
        config.labels
      );
    }

    // Request reviewers if requested
    if (config.reviewers && config.reviewers.length > 0) {
      await this.requestReviewers(
        auth.token,
        config.repository.owner,
        config.repository.name,
        data.number,
        config.reviewers
      );
    }

    return result;
  }

  /**
   * Check whether a repository is accessible to the GitHub App installation.
   */
  async checkRepositoryAccess(config: GetRepositoryConfig): Promise<RepositoryAccessResult | null> {
    if (!this.appConfigs || this.appConfigs.length === 0) {
      throw new SourceControlProviderError(
        "GitHub App not configured - cannot check repository access",
        "permanent"
      );
    }

    try {
      for (const appConfig of this.appConfigs) {
        const repo = await getInstallationRepository(appConfig, config.owner, config.name, {
          cacheStore: this.cacheStore,
          userAgent: this.userAgent,
        });
        if (repo && !repo.archived) {
          return {
            repoId: repo.id,
            repoOwner: config.owner.toLowerCase(),
            repoName: config.name.toLowerCase(),
            defaultBranch: repo.defaultBranch,
          };
        }
      }
      return null;
    } catch (error) {
      throw SourceControlProviderError.fromFetchError(
        `Failed to check repository access: ${error instanceof Error ? error.message : String(error)}`,
        error,
        extractHttpStatus(error)
      );
    }
  }

  /**
   * List all repositories accessible to the GitHub App installation.
   */
  async listRepositories(): Promise<InstallationRepository[]> {
    if (!this.appConfigs || this.appConfigs.length === 0) {
      throw new SourceControlProviderError(
        "GitHub App not configured - cannot list repositories",
        "permanent"
      );
    }

    try {
      const results = await Promise.all(
        this.appConfigs.map((appConfig) =>
          listInstallationRepositories(appConfig, {
            cacheStore: this.cacheStore,
            userAgent: this.userAgent,
          })
        )
      );
      const seen = new Set<string>();
      const allRepos: InstallationRepository[] = [];
      for (const result of results) {
        for (const repo of result.repos) {
          if (repo.archived) continue;
          if (seen.has(repo.fullName)) continue;
          seen.add(repo.fullName);
          allRepos.push(repo);
        }
      }
      return allRepos;
    } catch (error) {
      throw SourceControlProviderError.fromFetchError(
        `Failed to list repositories: ${error instanceof Error ? error.message : String(error)}`,
        error,
        extractHttpStatus(error)
      );
    }
  }

  /**
   * List branches for a repository.
   */
  async listBranches(config: GetRepositoryConfig): Promise<{ name: string }[]> {
    if (!this.appConfigs || this.appConfigs.length === 0) {
      throw new SourceControlProviderError(
        "GitHub App not configured - cannot list branches",
        "permanent"
      );
    }

    try {
      const appConfig = await this.resolveConfigForRepo(config);
      return await listRepositoryBranches(appConfig, config.owner, config.name, {
        cacheStore: this.cacheStore,
        userAgent: this.userAgent,
      });
    } catch (error) {
      throw SourceControlProviderError.fromFetchError(
        `Failed to list branches: ${error instanceof Error ? error.message : String(error)}`,
        error,
        extractHttpStatus(error)
      );
    }
  }

  /**
   * Generate authentication for git push operations using GitHub App.
   */
  async generatePushAuth(config?: GetRepositoryConfig): Promise<GitPushAuthContext> {
    if (!this.appConfigs || this.appConfigs.length === 0) {
      throw new SourceControlProviderError(
        "GitHub App not configured - cannot generate push auth",
        "permanent"
      );
    }

    try {
      const appConfig = config ? await this.resolveConfigForRepo(config) : this.appConfigs[0];
      const token = await getCachedInstallationToken(appConfig, {
        cacheStore: this.cacheStore,
        userAgent: this.userAgent,
      });
      return {
        authType: "app",
        token,
      };
    } catch (error) {
      throw SourceControlProviderError.fromFetchError(
        `Failed to generate GitHub App token: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async generateCredentialHelperAuth(config?: GetRepositoryConfig): Promise<CredentialHelperAuth> {
    if (!this.appConfigs || this.appConfigs.length === 0) {
      throw new SourceControlProviderError(
        "GitHub App not configured - cannot generate credential helper auth",
        "permanent"
      );
    }

    try {
      const appConfig = config ? await this.resolveConfigForRepo(config) : this.appConfigs[0];
      const { token, expiresAtEpochMs } = await getCachedInstallationTokenWithExpiry(appConfig, {
        cacheStore: this.cacheStore,
        userAgent: this.userAgent,
      });
      return {
        username: "x-access-token",
        password: token,
        expiresAtEpochMs,
      };
    } catch (error) {
      throw SourceControlProviderError.fromFetchError(
        `Failed to generate GitHub credential helper auth: ${error instanceof Error ? error.message : String(error)}`,
        error,
        extractHttpStatus(error)
      );
    }
  }

  /**
   * Resolve which appConfig (installation) has access to the given repo.
   * Tries each installation in order until one can access the repo.
   * Falls back to the first config if none match (for forward-compat).
   */
  private async resolveConfigForRepo(
    config: GetRepositoryConfig
  ): Promise<NonNullable<GitHubProviderConfig["appConfigs"]>[number]> {
    if (!this.appConfigs || this.appConfigs.length === 0) {
      throw new SourceControlProviderError("GitHub App not configured", "permanent");
    }
    if (this.appConfigs.length === 1) {
      return this.appConfigs[0];
    }
    for (const appConfig of this.appConfigs) {
      const repo = await getInstallationRepository(appConfig, config.owner, config.name, {
        cacheStore: this.cacheStore,
        userAgent: this.userAgent,
      });
      if (repo) {
        return appConfig;
      }
    }
    return this.appConfigs[0];
  }

  buildManualPullRequestUrl(config: BuildManualPullRequestUrlConfig): string {
    const encodedOwner = encodeURIComponent(config.owner);
    const encodedName = encodeURIComponent(config.name);
    const encodedBase = encodeURIComponent(config.targetBranch);
    const encodedHead = encodeURIComponent(config.sourceBranch);
    return `https://github.com/${encodedOwner}/${encodedName}/pull/new/${encodedBase}...${encodedHead}`;
  }

  buildGitPushSpec(config: BuildGitPushSpecConfig): GitPushSpec {
    const force = config.force ?? false;
    const remoteUrl = `https://x-access-token:${config.auth.token}@github.com/${config.owner}/${config.name}.git`;
    const redactedRemoteUrl = `https://x-access-token:<redacted>@github.com/${config.owner}/${config.name}.git`;

    return {
      remoteUrl,
      redactedRemoteUrl,
      refspec: `${config.sourceRef}:refs/heads/${config.targetBranch}`,
      targetBranch: config.targetBranch,
      force,
    };
  }

  /**
   * Add labels to a pull request.
   * This is a best-effort operation - failures are logged but don't fail the PR creation.
   */
  private async addLabels(
    accessToken: string,
    owner: string,
    repo: string,
    prNumber: number,
    labels: string[]
  ): Promise<void> {
    try {
      const response = await fetchWithTimeout(
        `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${prNumber}/labels`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github.v3+json",
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": this.userAgent,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ labels }),
        }
      );

      if (!response.ok) {
        // Log but don't throw - labels are best-effort
        console.warn(`Failed to add labels to PR #${prNumber}: ${response.status}`);
      }
    } catch (error) {
      console.warn(`Failed to add labels to PR #${prNumber}:`, error);
    }
  }

  /**
   * Request reviewers for a pull request.
   * This is a best-effort operation - failures are logged but don't fail the PR creation.
   */
  private async requestReviewers(
    accessToken: string,
    owner: string,
    repo: string,
    prNumber: number,
    reviewers: string[]
  ): Promise<void> {
    try {
      const response = await fetchWithTimeout(
        `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}/requested_reviewers`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github.v3+json",
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": this.userAgent,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ reviewers }),
        }
      );

      if (!response.ok) {
        // Log but don't throw - reviewers are best-effort
        console.warn(`Failed to request reviewers for PR #${prNumber}: ${response.status}`);
      }
    } catch (error) {
      console.warn(`Failed to request reviewers for PR #${prNumber}:`, error);
    }
  }
}

/**
 * Create a GitHub source control provider.
 *
 * @param config - Provider configuration (optional)
 * @returns GitHub source control provider instance
 */
export function createGitHubProvider(config: GitHubProviderConfig = {}): SourceControlProvider {
  return new GitHubSourceControlProvider(config);
}
