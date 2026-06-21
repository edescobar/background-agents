"use client";

import { ActionBar } from "@/components/action-bar";
import { ReasoningEffortPills } from "@/components/reasoning-effort-pills";
import { Combobox, type ComboboxGroup } from "@/components/ui/combobox";
import { ModelIcon, SendIcon, StopIcon } from "@/components/ui/icons";
import { formatModelNameLower } from "@/lib/format";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import type { Artifact } from "@/types/session";

type PendingAttachment = {
  id: string;
  name: string;
  url: string;
};

type SessionPromptComposerProps = {
  session: {
    id: string;
    status: string;
    artifacts: Artifact[];
    onArchive: () => void | Promise<void>;
    onUnarchive: () => void | Promise<void>;
  };
  prompt: {
    value: string;
    isProcessing: boolean;
    inputRef: React.RefObject<HTMLTextAreaElement | null>;
    onSubmit: (e: React.FormEvent) => void;
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
    onStopExecution: () => void;
    onUpload: (file: File) => void;
    pendingAttachments: PendingAttachment[];
    onRemoveAttachment: (id: string) => void;
  };
  model: {
    selectedModel: string;
    reasoningEffort: string | undefined;
    items: ComboboxGroup[];
    onModelChange: (model: string) => void;
    onReasoningEffortChange: (value: string | undefined) => void;
  };
};

export function SessionPromptComposer({ session, prompt, model }: SessionPromptComposerProps) {
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (const file of files) {
      if (file.type.startsWith("image/")) {
        prompt.onUpload(file);
      }
    }
    e.target.value = "";
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) prompt.onUpload(file);
        return;
      }
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const files = e.dataTransfer?.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      if (file.type.startsWith("image/")) {
        prompt.onUpload(file);
      }
    }
  };

  const canSend = prompt.value.trim() || prompt.pendingAttachments.length > 0;

  return (
    <footer className="border-t border-border-muted flex-shrink-0">
      <form onSubmit={prompt.onSubmit} className="max-w-4xl mx-auto p-4 pb-6">
        {/* Action bar above input */}
        <div className="mb-3">
          <ActionBar
            sessionId={session.id}
            sessionStatus={session.status}
            artifacts={session.artifacts}
            onArchive={session.onArchive}
            onUnarchive={session.onUnarchive}
          />
        </div>

        {/* Input container */}
        <div
          className="border border-border bg-input"
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          {/* Pending image attachments */}
          {prompt.pendingAttachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-4 pt-3">
              {prompt.pendingAttachments.map((att) => (
                <div key={att.id} className="relative group">
                  <img
                    src={att.url}
                    alt={att.name}
                    className="h-16 w-16 object-cover rounded border border-border-muted"
                  />
                  <button
                    type="button"
                    onClick={() => prompt.onRemoveAttachment(att.id)}
                    className="absolute -top-1 -right-1 p-0.5 bg-destructive text-destructive-foreground rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                    aria-label="Remove attachment"
                  >
                    <svg
                      className="w-3 h-3"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Text input area with floating send button */}
          <div className="relative">
            <textarea
              ref={prompt.inputRef}
              value={prompt.value}
              onChange={prompt.onChange}
              onKeyDown={prompt.onKeyDown}
              onPaste={handlePaste}
              placeholder={
                prompt.isProcessing ? "Type your next message..." : "Ask or build anything"
              }
              className="w-full resize-none bg-transparent px-4 pt-4 pb-12 focus:outline-none text-foreground placeholder:text-secondary-foreground"
              rows={3}
            />
            {/* Floating action buttons */}
            <div className="absolute bottom-3 right-3 flex items-center gap-2">
              {prompt.isProcessing && prompt.value.trim() && (
                <span className="text-xs text-warning">Waiting...</span>
              )}
              {prompt.isProcessing && (
                <button
                  type="button"
                  onClick={prompt.onStopExecution}
                  className="p-2 text-destructive hover:bg-destructive-muted transition"
                  title="Stop"
                >
                  <StopIcon className="w-5 h-5" />
                </button>
              )}
              <button
                type="submit"
                disabled={!canSend || prompt.isProcessing}
                className="p-2 text-secondary-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition"
                title={
                  prompt.isProcessing && canSend
                    ? "Wait for execution to complete"
                    : `Send (${SHORTCUT_LABELS.SEND_PROMPT})`
                }
                aria-label={
                  prompt.isProcessing && canSend
                    ? "Wait for execution to complete"
                    : `Send (${SHORTCUT_LABELS.SEND_PROMPT})`
                }
              >
                <SendIcon className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Footer row with model selector, reasoning pills, image button, and agent label */}
          <div className="flex flex-col gap-2 px-4 py-2 border-t border-border-muted sm:flex-row sm:items-center sm:justify-between sm:gap-0">
            {/* Left side - Model selector + Reasoning pills + Image upload */}
            <div className="flex flex-wrap items-center gap-2 sm:gap-4 min-w-0">
              <Combobox
                value={model.selectedModel}
                onChange={model.onModelChange}
                items={model.items}
                direction="up"
                dropdownWidth="w-56"
                disabled={prompt.isProcessing}
                triggerClassName="flex max-w-full items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition"
              >
                <ModelIcon className="w-3.5 h-3.5" />
                <span className="truncate max-w-[9rem] sm:max-w-none">
                  {formatModelNameLower(model.selectedModel)}
                </span>
              </Combobox>

              {/* Reasoning effort pills */}
              <ReasoningEffortPills
                selectedModel={model.selectedModel}
                reasoningEffort={model.reasoningEffort}
                onSelect={model.onReasoningEffortChange}
                disabled={prompt.isProcessing}
              />

              {/* Image upload button */}
              <label className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground cursor-pointer transition">
                <svg
                  className="w-4 h-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0019.5 3H4.5A2.25 2.25 0 002.5 5.25v13.5A2.25 2.25 0 004.5 21z"
                  />
                </svg>
                <span className="hidden sm:inline">Image</span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  onChange={handleFileSelect}
                  className="hidden"
                  disabled={prompt.isProcessing}
                />
              </label>
            </div>

            {/* Right side - Agent label */}
            <span className="hidden sm:inline text-sm text-muted-foreground">build agent</span>
          </div>
        </div>
      </form>
    </footer>
  );
}
