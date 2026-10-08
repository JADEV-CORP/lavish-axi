/* global document, window */

// The composer's rich text editor (#3328, #3329), after T3 Code's: TipTap with Markdown recognised
// as you type, links, `@` mentions of marked blocks and attached pictures, and pasted pictures as
// inline "Image N" chips. Bundled to dist/composer/composer.js and loaded before chrome-client.js,
// it swaps the composer <textarea id="chatInput"> for an editor host that keeps the id and the
// surface chrome-client uses - value (as Markdown), placeholder, disabled, focus(),
// setSelectionRange(), and key, input and paste events bubbling from the editor - so the rest of
// the chrome is unchanged. If this bundle does not load, the textarea simply stays.

import { Editor, Extension, Node, mergeAttributes } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import Mention from "@tiptap/extension-mention";
import { Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

const QUIET = "lavish-quiet";

/** @typedef {{ id: string, url: string, name: string }} ComposerPicture */
/** @typedef {{ number: number, label: string }} ComposerMark */

function mountComposerEditor(textarea) {
  /** @type {ComposerPicture[]} */
  let pictures = [];
  /** @type {ComposerMark[]} */
  let marks = [];

  // The host takes over the textarea's id and gains the textarea surface chrome-client uses.
  const host = /** @type {any} */ (document.createElement("div"));
  host.id = textarea.id;
  host.className = "composer-editor";
  host.setAttribute("data-composer-rich-text", "true");
  const placeholderText = { value: textarea.getAttribute("placeholder") || "" };

  // Every picture chip on screen, so a change in the list renumbers and re-previews them all.
  /** @type {Set<{ id: string, render: (id: string) => void }>} */
  const chipViews = new Set();
  const pictureNumber = (id) => pictures.findIndex((picture) => picture.id === id) + 1;
  const pictureLabel = (id) => {
    const number = pictureNumber(id);
    return number ? "Image " + number : "Image";
  };

  // A pasted or attached picture, as an inline chip that says which attachment it is.
  const PictureChip = Node.create({
    name: "lavishPicture",
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,
    addAttributes() {
      return { id: { default: "" } };
    },
    parseHTML() {
      return [{ tag: "span[data-composer-picture]", getAttrs: (el) => ({ id: el.getAttribute("data-id") || "" }) }];
    },
    renderHTML({ node, HTMLAttributes }) {
      return [
        "span",
        mergeAttributes(HTMLAttributes, { "data-composer-picture": "", "data-id": node.attrs.id }),
        pictureLabel(node.attrs.id),
      ];
    },
    renderText({ node }) {
      return "[" + pictureLabel(node.attrs.id) + "]";
    },
    renderMarkdown: (node) => "[" + pictureLabel(node.attrs?.id) + "]",
    addNodeView() {
      return ({ node }) => {
        const dom = document.createElement("span");
        dom.className = "composer-chip composer-chip-picture";
        dom.contentEditable = "false";
        dom.setAttribute("data-composer-picture", "");
        const render = (id) => {
          const picture = pictures.find((candidate) => candidate.id === id);
          dom.textContent = "";
          // The label goes first so the chip's baseline is the label's and sits on the line with
          // the words around it; CSS draws the thumbnail before it.
          const label = document.createElement("span");
          label.textContent = pictureLabel(id);
          dom.append(label);
          if (picture?.url) {
            const thumb = document.createElement("img");
            thumb.className = "composer-chip-thumb";
            thumb.src = picture.url;
            thumb.alt = "";
            dom.append(thumb);
            const preview = document.createElement("img");
            preview.className = "composer-chip-preview";
            preview.src = picture.url;
            preview.alt = picture.name || "";
            dom.append(preview);
          }
          dom.title = picture?.name || "";
        };
        const view = { id: node.attrs.id, render };
        chipViews.add(view);
        render(view.id);
        return {
          dom,
          update(updated) {
            if (updated.type.name !== "lavishPicture") return false;
            view.id = updated.attrs.id;
            render(view.id);
            return true;
          },
          destroy() {
            chipViews.delete(view);
          },
        };
      };
    },
  });

  // `@` picks a marked block (written as [Mark N], the number its pin shows and the agent receives)
  // or an attached picture (written as its chip). The menu is plain DOM in the chrome's menu style.
  const MarkMention = Mention.extend({
    name: "lavishMark",
    // Ahead of the composer keys, so an open menu takes Enter, Tab and the arrows first.
    priority: 200,
    renderMarkdown: (node) => "[" + (node.attrs?.label || "Mark") + "]",
  }).configure({
    HTMLAttributes: { class: "composer-chip composer-chip-mark" },
    renderText: ({ node }) => "[" + (node.attrs.label || "Mark") + "]",
    renderHTML: ({ node, options }) => ["span", mergeAttributes(options.HTMLAttributes), node.attrs.label || "Mark"],
    suggestion: {
      char: "@",
      allowSpaces: false,
      items: ({ query }) => {
        const needle = String(query || "").toLowerCase();
        const options = [
          ...marks.map((mark) => ({
            kind: "mark",
            id: String(mark.number),
            label: "Mark " + mark.number,
            hint: mark.label,
          })),
          ...pictures.map((picture) => ({
            kind: "picture",
            id: picture.id,
            label: pictureLabel(picture.id),
            hint: picture.name,
            url: picture.url,
          })),
        ];
        return options
          .filter((option) => !needle || (option.label + " " + option.hint).toLowerCase().includes(needle))
          .slice(0, 8);
      },
      command: ({ editor, range, props: picked }) => {
        const props = /** @type {any} */ (picked);
        const node =
          props.kind === "picture"
            ? { type: "lavishPicture", attrs: { id: props.id } }
            : { type: "lavishMark", attrs: { id: props.id, label: props.label } };
        editor
          .chain()
          .focus()
          .insertContentAt(range, [node, { type: "text", text: " " }])
          .run();
      },
      render: mentionMenu,
    },
  });

  // Enter belongs to the chrome (send, or save a queued edit); Shift+Enter starts a new line: the
  // next list item in a list, a new line in a code block, otherwise a new paragraph. An open `@` menu still takes Enter first.
  const ComposerKeys = Extension.create({
    name: "lavishComposerKeys",
    // Ahead of StarterKit's hard break, which also claims Shift+Enter.
    priority: 150,
    addKeyboardShortcuts() {
      return {
        Enter: () => true,
        "Shift-Enter": ({ editor }) =>
          editor.commands.first(({ commands }) => [
            () => commands.newlineInCode(),
            () => commands.splitListItem("listItem"),
            // A new paragraph, not a line break, so `- `, `1. ` and `## ` work on the new line too.
            () => commands.splitBlock(),
          ]),
      };
    },
  });

  const editor = new Editor({
    element: host,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        underline: false,
        trailingNode: false,
        link: false,
      }),
      // A link whose text is its address is written as the bare address, as it was typed.
      Link.extend({
        // Marks render around a placeholder; the real text arrives as meta.markText.
        renderMarkdown: (node, helpers, context) => {
          const href = String(node.attrs?.href || "");
          const inner = helpers.renderChildren(node);
          return context?.meta?.markText === href ? inner : "[" + inner + "](" + href + ")";
        },
      }).configure({ openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: "https" }),
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
      Placeholder.configure({ placeholder: () => placeholderText.value }),
      PictureChip,
      MarkMention,
      ComposerKeys,
    ],
    editorProps: {
      attributes: { class: "composer-prose", role: "textbox", "aria-multiline": "true", "aria-label": "Message" },
      // A pasted picture becomes an attachment and a chip (chrome-client's paste listener on the host
      // adds it); the editor only steps aside when the clipboard has nothing else to paste.
      handlePaste: (_view, event) => {
        const data = event.clipboardData;
        const hasPicture = Array.from(data?.files || []).some((file) => String(file.type).startsWith("image/"));
        return hasPicture && !String(data?.getData("text/plain") || "").trim();
      },
    },
  });

  // The agent reads the message as written: the serializer's HTML entities (`<` as `&lt;`) and
  // backslash escapes (`it_is` as `it\_is`) are for HTML round trips, not for a reader. Formatting
  // the writer applied still comes out as Markdown. Relies on @tiptap/markdown's per-text hook, so
  // the package is pinned to an exact version.
  /** @type {any} */ (editor.markdown).encodeTextForMarkdown = (/** @type {string} */ text) => text;

  // chrome-client listens for `input` on the host: one per change, including changes it did not
  // type (an input rule, a chip), and none for the value it set itself.
  editor.view.dom.addEventListener("input", (event) => event.stopPropagation());
  let lastPictureIds = [];
  editor.on("update", ({ transaction }) => {
    const ids = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "lavishPicture") ids.push(node.attrs.id);
    });
    const quiet = transaction.getMeta(QUIET);
    if (!quiet) {
      for (const id of lastPictureIds) {
        if (!ids.includes(id)) host.dispatchEvent(new CustomEvent("lavish-picture-removed", { detail: { id } }));
      }
    }
    lastPictureIds = ids;
    if (!quiet) host.dispatchEvent(new Event("input", { bubbles: true }));
  });

  Object.defineProperties(host, {
    value: {
      get: () => (editor.isEmpty ? "" : editor.getMarkdown().replace(/\s+$/, "")),
      set: (text) => {
        editor
          .chain()
          .setMeta(QUIET, true)
          .setContent(String(text ?? ""), { contentType: "markdown", emitUpdate: true })
          .run();
      },
    },
    placeholder: {
      get: () => placeholderText.value,
      set: (text) => {
        placeholderText.value = String(text ?? "");
        editor.view.dispatch(editor.state.tr.setMeta(QUIET, true));
      },
    },
    disabled: {
      get: () => !editor.isEditable,
      set: (value) => {
        editor.setEditable(!value, false);
        host.toggleAttribute("aria-disabled", Boolean(value));
      },
    },
  });
  host.focus = () => {
    editor.commands.focus();
  };
  host.setSelectionRange = () => {
    editor.commands.focus("end");
  };
  /** The composer's attachments, in order: the chips number and preview themselves from this. */
  host.syncPictures = (/** @type {ComposerPicture[]} */ list) => {
    pictures = Array.isArray(list) ? list : [];
    const missing = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "lavishPicture" && !pictures.some((picture) => picture.id === node.attrs.id))
        missing.push(pos);
    });
    if (missing.length) {
      const tr = editor.state.tr.setMeta(QUIET, true);
      for (const pos of missing.reverse()) tr.delete(pos, pos + 1);
      editor.view.dispatch(tr);
    }
    // Numbers shift when a picture before them goes, and a preview arrives after the chip.
    for (const view of chipViews) view.render(view.id);
  };
  /** A picture just pasted, dropped or attached: its chip goes where the cursor is. */
  host.insertPicture = (/** @type {string} */ id) => {
    // Focus first: after the attach button's file picker the cursor goes back into the text.
    editor
      .chain()
      .focus()
      .setMeta(QUIET, true)
      .insertContent([
        { type: "lavishPicture", attrs: { id } },
        { type: "text", text: " " },
      ])
      .run();
  };
  /** The blocks marked for this message, for `@`; a chip whose mark is gone goes with it. */
  host.syncMarks = (/** @type {ComposerMark[]} */ list) => {
    marks = Array.isArray(list) ? list : [];
    const missing = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "lavishMark" && !marks.some((mark) => String(mark.number) === String(node.attrs.id)))
        missing.push(pos);
    });
    if (!missing.length) return;
    const tr = editor.state.tr.setMeta(QUIET, true);
    for (const pos of missing.reverse()) tr.delete(pos, pos + 1);
    editor.view.dispatch(tr);
  };
  host.composerEditor = editor;
  // Only a fully started editor takes the textarea's place.
  textarea.replaceWith(host);
  return host;
}

// The `@` menu: plain DOM placed above the caret, since the composer sits at the bottom.
function mentionMenu() {
  /** @type {HTMLDivElement | null} */
  let menu = null;
  let active = 0;
  /** @type {any} */
  let current = null;

  function draw() {
    if (!menu || !current) return;
    menu.textContent = "";
    if (!current.items.length) {
      const empty = document.createElement("div");
      empty.className = "composer-mention-empty";
      empty.textContent = "Mark a block or attach a picture to mention it.";
      menu.append(empty);
      return;
    }
    current.items.forEach((item, index) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "menu-item composer-mention-item" + (index === active ? " is-active" : "");
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(index === active));
      if (item.url) {
        const thumb = document.createElement("img");
        thumb.className = "composer-chip-thumb";
        thumb.src = item.url;
        thumb.alt = "";
        option.append(thumb);
      }
      const label = document.createElement("span");
      label.className = "composer-mention-label";
      label.textContent = item.label;
      option.append(label);
      if (item.hint) {
        const hint = document.createElement("span");
        hint.className = "composer-mention-hint";
        hint.textContent = item.hint;
        option.append(hint);
      }
      option.addEventListener("mousedown", (event) => event.preventDefault());
      option.addEventListener("click", () => current.command(item));
      menu?.append(option);
    });
  }

  function place() {
    if (!menu || !current?.clientRect) return;
    const rect = current.clientRect();
    if (!rect) return;
    const width = menu.offsetWidth || 260;
    menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + "px";
    menu.style.bottom = Math.max(8, window.innerHeight - rect.top + 6) + "px";
  }

  return {
    onStart(props) {
      current = props;
      active = 0;
      menu = document.createElement("div");
      menu.className = "menu composer-mention-menu";
      menu.setAttribute("role", "listbox");
      menu.setAttribute("aria-label", "Mention");
      document.body.append(menu);
      draw();
      place();
    },
    onUpdate(props) {
      current = props;
      active = Math.min(active, Math.max(0, props.items.length - 1));
      draw();
      place();
    },
    onKeyDown({ event }) {
      if (!current) return false;
      const count = current.items.length;
      const handled = () => {
        // The chrome's own Enter (send) and Escape listeners sit on the host: keep it from them.
        event.stopPropagation();
        return true;
      };
      if (event.key === "Escape") {
        menu?.remove();
        menu = null;
        return handled();
      }
      if (!count) return false;
      if (event.key === "ArrowDown") {
        active = (active + 1) % count;
        draw();
        return handled();
      }
      if (event.key === "ArrowUp") {
        active = (active - 1 + count) % count;
        draw();
        return handled();
      }
      if (event.key === "Enter" || event.key === "Tab") {
        current.command(current.items[active]);
        return handled();
      }
      return false;
    },
    onExit() {
      menu?.remove();
      menu = null;
      current = null;
    },
  };
}

const textarea = document.getElementById("chatInput");
if (textarea && textarea.tagName === "TEXTAREA") {
  try {
    mountComposerEditor(textarea);
  } catch (error) {
    // The plain textarea keeps working; the editor is an enhancement.
    console.error("Lavish composer editor failed to start:", error);
  }
}
