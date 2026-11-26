// Where a review opens. Inside T3 Code or VS Code's agent chat the review belongs beside the
// conversation, not in a separate browser window. No command can put a page in those panels from
// the outside, but the agent can: T3 Code gives it `preview_open`, VS Code's chat gives it
// `openBrowserPage`. So Lavish skips the external browser there and tells the agent which tool to
// call. T3 Code is detected by T3CODE_THREAD_ID; VS Code needs LAVISH_AXI_OPEN=panel. `--external`
// or LAVISH_AXI_OPEN=external always opens the user's browser.

/**
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ id: "t3" | "vscode", place: string, tool: string } | null}
 */
export function detectReviewHost(args, env) {
  if (args.includes("--external") || env.LAVISH_AXI_OPEN === "external") return null;
  if (env.T3CODE_THREAD_ID) {
    return {
      id: "t3",
      place: "this thread's preview panel in T3 Code",
      tool: "preview_open (mcp__t3-code__preview_open)",
    };
  }
  // Every VS Code terminal sets TERM_PROGRAM=vscode, whoever types in it, so the panel is opt-in
  // there: LAVISH_AXI_OPEN=panel, set once in VS Code's terminal env for Copilot's agent chat.
  if (env.TERM_PROGRAM === "vscode" && env.LAVISH_AXI_OPEN === "panel") {
    return {
      id: "vscode",
      place: "VS Code's integrated browser, beside the chat",
      tool: "openBrowserPage (open_browser_page)",
    };
  }
  return null;
}

/** The step that puts the review beside the chat, with the way back to the external browser. */
export function hostOpenStep(host, file, url) {
  if (!host) return "";
  return `Show the review in ${host.place} first: call the ${host.tool} tool with url ${url}. If you do not have that tool, run \`lavish-axi ${file} --external\` to open the user's browser instead. `;
}
