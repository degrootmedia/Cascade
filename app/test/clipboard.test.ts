/**
 * Clipboard → plain text. Rich sources put real structure in the HTML flavor;
 * Chromium's plain flavor flattens paragraph breaks. These tests pin the
 * conversions both the chat composer and the prompt editor paste through.
 */
import { describe, it, expect } from "vitest";
import { clipboardText, htmlToPlainText } from "../src/renderer/src/clipboard.js";

function dt(data: Record<string, string>): DataTransfer {
  return { getData: (t: string) => data[t] ?? "" } as unknown as DataTransfer;
}

describe("htmlToPlainText", () => {
  it("separates block paragraphs with a blank line", () => {
    expect(htmlToPlainText("<p>First para</p><p>Second para</p>")).toBe("First para\n\nSecond para");
  });

  it("turns <br> into a single line break", () => {
    expect(htmlToPlainText("<div>line one<br>line two</div>")).toBe("line one\nline two");
  });

  it("collapses nested block wrappers to one blank line", () => {
    expect(htmlToPlainText("<div><p>a</p><p>b</p></div>")).toBe("a\n\nb");
  });

  it("keeps text and indentation inside <pre>", () => {
    expect(htmlToPlainText("<pre>def f():\n    return 1</pre>")).toBe("def f():\n    return 1");
  });

  it("separates list items", () => {
    expect(htmlToPlainText("<ul><li>one</li><li>two</li></ul>")).toBe("one\n\ntwo");
  });

  it("keeps inline markup on one line", () => {
    expect(htmlToPlainText("<p>Hello <strong>world</strong>!</p>")).toBe("Hello world!");
  });

  it("preserves literal newlines in a pre-wrap element (our own chat bubbles)", () => {
    expect(htmlToPlainText('<div style="white-space: pre-wrap">Line one\nLine two\n\nPara two</div>')).toBe(
      "Line one\nLine two\n\nPara two",
    );
  });

  it("drops serialization whitespace between block children", () => {
    expect(htmlToPlainText("<body>\n  <p>a</p>\n  <p>b</p>\n</body>")).toBe("a\n\nb");
  });

  it("drops UI chrome such as the chat's code-block Copy button", () => {
    expect(htmlToPlainText('<div class="code-block-wrap"><pre>code</pre><button class="code-copy-btn">Copy</button></div>')).toBe("code");
  });

  it("returns an empty string for empty input", () => {
    expect(htmlToPlainText("")).toBe("");
  });
});

describe("clipboardText", () => {
  it("prefers the structured HTML flavor", () => {
    expect(clipboardText(dt({ "text/html": "<p>a</p><p>b</p>", "text/plain": "a b" }))).toBe("a\n\nb");
  });

  it("falls back to the plain flavor (CRLF-normalized)", () => {
    expect(clipboardText(dt({ "text/plain": "x\r\ny" }))).toBe("x\ny");
  });

  it("returns empty for a text-free (file-only) clipboard", () => {
    expect(clipboardText(dt({}))).toBe("");
    expect(clipboardText(null)).toBe("");
  });
});
