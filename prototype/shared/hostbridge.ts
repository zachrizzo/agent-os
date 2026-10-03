// Protocol between the Agent OS app (sandboxed iframe) and the Control UI plugin that frames it (plugin/src/host-actions.ts).
// The app cannot reach the host, so it asks the plugin to run the few host actions that exist as public SDK calls.
// The plugin answers with the actions it can actually run; the app renders a button only for those (no dead buttons).
// Keep the strings in sync with plugin/src/host-actions.ts.
export const HOST_ACTIONS = ['open-session'] as const;
export type HostAction = (typeof HOST_ACTIONS)[number];

export const MSG_CAPS_REQUEST = 'agent-os:host-caps-request';
export const MSG_CAPS = 'agent-os:host-caps';
export const MSG_ACTION = 'agent-os:host-action';
export const MSG_RESULT = 'agent-os:host-action-result';

export interface HostCapsMessage { type: typeof MSG_CAPS; actions: HostAction[] }
export interface HostActionMessage { type: typeof MSG_ACTION; id: number; action: HostAction; sessionKey: string }
export interface HostResultMessage { type: typeof MSG_RESULT; id: number; ok: boolean; error?: string }

export const isHostAction = (v: unknown): v is HostAction => (HOST_ACTIONS as readonly string[]).includes(v as string);
