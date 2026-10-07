import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export const ARTIFACT_HTML_ERROR = "Lavish Editor expects an HTML file";

/**
 * Match the CLI: Lavish reviews HTML files, so only `.html` / `.htm` (any case) count.
 * @param {unknown} file
 * @returns {boolean}
 */
export function isHtmlPath(file) {
  const lower = String(file || "").toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm");
}

/**
 * Directory `/artifact/:key/*` may read: the canonical HTML file's own directory.
 * A caller cannot pick a different tree by registering a non-HTML path.
 * @param {string} file
 * @returns {string}
 */
export function artifactTreeRoot(file) {
  return path.dirname(file);
}

/**
 * Jadev fork: whether a path below the artifact tree names a hidden file or folder (any segment
 * starting with a dot, on either separator). `/artifact` refuses those, so a `.env` or `.git/`
 * beside an artifact is never served. Callers pass only the part below the tree root; the root
 * itself is often a dot-folder such as `.lavish/`.
 * @param {string} relativePath
 * @returns {boolean}
 */
export function hasHiddenSegment(relativePath) {
  return String(relativePath || "")
    .split(/[\\/]/)
    .some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..");
}

export class ArtifactPathError extends Error {
  /** @type {"VALIDATION_ERROR"} */
  code = "VALIDATION_ERROR";
  /** @type {400} */
  statusCode = 400;

  /**
   * @param {string} [message]
   */
  constructor(message = ARTIFACT_HTML_ERROR) {
    super(message);
    this.name = "ArtifactPathError";
  }
}

/**
 * @param {unknown} error
 * @returns {error is ArtifactPathError}
 */
export function isArtifactPathError(error) {
  return error instanceof Error && error.name === "ArtifactPathError";
}

/**
 * Canonicalize a session-create path and refuse anything that is not a regular HTML file.
 * The request name and the symlink-followed real path both have to be HTML, so
 * `preview.html -> /etc/passwd` cannot adopt `/etc` as a serving tree.
 * @param {unknown} file
 * @returns {Promise<string>}
 */
export async function resolveAllowedArtifactFile(file) {
  const requested = typeof file === "string" ? file : "";
  if (!isHtmlPath(requested)) {
    throw new ArtifactPathError();
  }
  const canonical = await realpath(path.resolve(requested));
  if (!isHtmlPath(canonical)) {
    throw new ArtifactPathError();
  }
  const info = await stat(canonical);
  if (!info.isFile()) {
    throw new ArtifactPathError();
  }
  return canonical;
}
