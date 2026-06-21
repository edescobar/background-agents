import { createKvCacheStore, resolveAppName } from "@open-inspect/shared";
import { getGitHubAppConfigs } from "../auth/github-app";
import type { Env } from "../types";
import { resolveScmProviderFromEnv } from "./config";
import { createSourceControlProvider } from "./providers";
import type { SourceControlProvider } from "./types";

export function createSourceControlProviderFromEnv(env: Env): SourceControlProvider {
  const appConfigs = getGitHubAppConfigs(env);
  const provider = resolveScmProviderFromEnv(env.SCM_PROVIDER);
  const userAgent = resolveAppName(env);

  return createSourceControlProvider({
    provider,
    github: {
      appConfigs: appConfigs.length > 0 ? appConfigs : undefined,
      cacheStore: createKvCacheStore(env.REPOS_CACHE),
      userAgent,
    },
    ...(env.GITLAB_ACCESS_TOKEN
      ? {
          gitlab: {
            accessToken: env.GITLAB_ACCESS_TOKEN,
            namespace: env.GITLAB_NAMESPACE,
            userAgent,
          },
        }
      : {}),
  });
}
