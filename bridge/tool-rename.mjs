// Rename table applied by wb-bridge before a request goes upstream.
// Reverse-applied on the way back so tool calls still reach the right tool.
//
// Rationale: the tool names are the strongest client fingerprint the bridge exposes
// (`spawn_teammate`, `mcp__github__*`, `dsh_im_return_file`, … are unique to DSH).
// Renaming keeps every capability working while removing those names from the wire.
export const TOOL_RENAME = {
  // ---- DSH agent / orchestration ----
  spawn_teammate: 'run_task',
  wait_agent: 'wait_task',
  list_agents: 'list_tasks',
  interrupt_agent: 'stop_task',
  workflow: 'run_pipeline',
  ralph: 'iterate',
  send_message: 'send_note',
  // ---- goals & planning ----
  create_goal: 'track_goal',
  update_goal: 'update_goal_status',
  get_goal: 'read_goal',
  exit_plan_mode: 'finish_planning',
  // ---- team task board ----
  team_task_create: 'add_task',
  team_task_get: 'read_task',
  team_task_list: 'list_project_tasks',
  team_task_update: 'update_task',
  // ---- background jobs ----
  job_list: 'list_jobs',
  job_kill: 'cancel_job',
  job_output: 'read_job',
  // ---- workspace ----
  create_worktree: 'create_branch_workspace',
  // ---- scheduling ----
  schedule_create: 'add_reminder',
  schedule_update: 'update_reminder',
  schedule_delete: 'delete_reminder',
  schedule_list: 'list_reminders',
  // ---- shell terminals ----
  terminal_open: 'open_shell',
  terminal_send: 'send_to_shell',
  terminal_read: 'read_shell',
  terminal_signal: 'signal_shell',
  terminal_close: 'close_shell',
  terminal_list: 'list_shells',
  // ---- UI surfaces ----
  dsh_im_return_file: 'send_file',
  ask_user_question: 'ask_user',
  // ---- ds-bot plugin tools ----
  create_bot: 'add_contact',
  update_bot: 'edit_contact',
  list_bots: 'list_contacts',
  stop_bot: 'stop_contact',
  message_bot: 'message_contact',
  read_own_chat: 'read_own_messages',
  group_relay: 'relay_group',
  create_group: 'add_group',
  delete_group: 'remove_group',
  read_group_chat: 'read_group_messages',
  post_to_group: 'post_group_message',
  list_bot_models: 'list_contact_models',
  attach_capability: 'attach_skill',
  detach_capability: 'detach_skill',
  list_capabilities: 'list_skills',
  save_capability: 'save_skill',
  delete_capability: 'delete_skill',
  request_secret: 'request_credential',
  list_secrets: 'list_credentials',
  remember: 'save_note',
  recall: 'search_notes',
  forget: 'delete_note',
  show_view: 'show_panel',
  read_browser: 'read_page',
}

/** `mcp__github__get_me` -> `github_get_me` */
export function renameTool(name) {
  if (typeof name !== 'string') return name
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  if (m) return `${m[1]}_${m[2]}`
  return TOOL_RENAME[name] ?? name
}
