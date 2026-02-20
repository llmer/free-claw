import { describe, it, expect } from "vitest";
import { markdownToTelegramHtml, isTelegramParseError } from "./format.js";

describe("markdownToTelegramHtml", () => {
  describe("HTML escaping", () => {
    it("escapes &, <, >", () => {
      expect(markdownToTelegramHtml("a & b < c > d")).toBe(
        "a &amp; b &lt; c &gt; d",
      );
    });

    it("preserves plain text unchanged (besides escaping)", () => {
      expect(markdownToTelegramHtml("hello world")).toBe("hello world");
    });
  });

  describe("inline code", () => {
    it("converts backtick code to <code>", () => {
      expect(markdownToTelegramHtml("use `foo()` here")).toBe(
        "use <code>foo()</code> here",
      );
    });

    it("escapes HTML inside inline code", () => {
      expect(markdownToTelegramHtml("use `<div>`")).toBe(
        "use <code>&lt;div&gt;</code>",
      );
    });

    it("does not match across newlines", () => {
      const input = "start `broken\ncode` end";
      expect(markdownToTelegramHtml(input)).not.toContain("<code>");
    });
  });

  describe("fenced code blocks", () => {
    it("converts closed code block", () => {
      const input = "```\nhello\n```";
      expect(markdownToTelegramHtml(input)).toBe(
        "<pre><code>hello</code></pre>",
      );
    });

    it("converts closed code block with language", () => {
      const input = '```js\nconsole.log("hi")\n```';
      expect(markdownToTelegramHtml(input)).toBe(
        '<pre><code class="language-js">console.log("hi")</code></pre>',
      );
    });

    it("escapes HTML inside code blocks", () => {
      const input = "```\n<div>&amp;</div>\n```";
      expect(markdownToTelegramHtml(input)).toBe(
        "<pre><code>&lt;div&gt;&amp;amp;&lt;/div&gt;</code></pre>",
      );
    });

    it("handles unclosed code block (streaming)", () => {
      const input = "```python\ndef foo():\n    pass";
      expect(markdownToTelegramHtml(input)).toBe(
        '<pre><code class="language-python">def foo():\n    pass</code></pre>',
      );
    });

    it("does not match bare ``` with no content", () => {
      const input = "text\n```";
      // Should not create a code block from just the fence
      expect(markdownToTelegramHtml(input)).not.toContain("<pre>");
    });

    it("handles multiple code blocks", () => {
      const input = "```\na\n```\ntext\n```\nb\n```";
      const result = markdownToTelegramHtml(input);
      expect(result).toContain("<pre><code>a</code></pre>");
      expect(result).toContain("<pre><code>b</code></pre>");
    });
  });

  describe("bold", () => {
    it("converts **bold** to <b>", () => {
      expect(markdownToTelegramHtml("this is **bold** text")).toBe(
        "this is <b>bold</b> text",
      );
    });

    it("handles multiple bold segments", () => {
      expect(markdownToTelegramHtml("**a** and **b**")).toBe(
        "<b>a</b> and <b>b</b>",
      );
    });
  });

  describe("italic", () => {
    it("converts *italic* to <i>", () => {
      expect(markdownToTelegramHtml("this is *italic* text")).toBe(
        "this is <i>italic</i> text",
      );
    });

    it("does not match mid-word asterisks", () => {
      const result = markdownToTelegramHtml("file*name*here");
      // Mid-word asterisks should be treated as italic since they're word-bounded
      // The lookbehind (?<!\w) prevents matching after a word char
      expect(result).not.toContain("<i>");
    });
  });

  describe("strikethrough", () => {
    it("converts ~~strike~~ to <s>", () => {
      expect(markdownToTelegramHtml("this is ~~old~~ text")).toBe(
        "this is <s>old</s> text",
      );
    });
  });

  describe("links", () => {
    it("converts [text](url) to <a>", () => {
      expect(markdownToTelegramHtml("[Google](https://google.com)")).toBe(
        '<a href="https://google.com">Google</a>',
      );
    });

    it("escapes & in URLs correctly", () => {
      const result = markdownToTelegramHtml("[link](https://x.com?a=1&b=2)");
      expect(result).toBe(
        '<a href="https://x.com?a=1&amp;b=2">link</a>',
      );
    });
  });

  describe("headings", () => {
    it("converts # heading to bold", () => {
      expect(markdownToTelegramHtml("# Title")).toBe("<b>Title</b>");
    });

    it("converts ## heading to bold", () => {
      expect(markdownToTelegramHtml("## Subtitle")).toBe("<b>Subtitle</b>");
    });

    it("does not convert # mid-line", () => {
      const result = markdownToTelegramHtml("not a # heading");
      expect(result).toBe("not a # heading");
    });
  });

  describe("blockquotes", () => {
    it("converts single > line to blockquote", () => {
      expect(markdownToTelegramHtml("> quoted text")).toBe(
        "<blockquote>quoted text</blockquote>\n",
      );
    });

    it("converts consecutive > lines to one blockquote", () => {
      const input = "> line 1\n> line 2\n> line 3";
      expect(markdownToTelegramHtml(input)).toBe(
        "<blockquote>line 1\nline 2\nline 3</blockquote>\n",
      );
    });

    it("preserves text after blockquote", () => {
      const input = "> quote\nnormal text";
      const result = markdownToTelegramHtml(input);
      expect(result).toContain("<blockquote>quote</blockquote>");
      expect(result).toContain("normal text");
    });
  });

  describe("mixed content", () => {
    it("handles bold inside heading", () => {
      // Bold runs before heading, so **text** inside heading becomes <b> from bold
      // then heading wraps the whole thing in another <b>
      const result = markdownToTelegramHtml("# My **Title**");
      expect(result).toContain("<b>");
    });

    it("handles code and bold together", () => {
      const result = markdownToTelegramHtml("Run `npm install` then **build**");
      expect(result).toBe(
        "Run <code>npm install</code> then <b>build</b>",
      );
    });

    it("handles full realistic response", () => {
      const input = [
        "# Summary",
        "",
        "Here is **bold** and *italic* text with `inline code`.",
        "",
        "```js",
        'console.log("hello");',
        "```",
        "",
        "> Note: this is important",
        "",
        "See [docs](https://example.com) for more.",
      ].join("\n");

      const result = markdownToTelegramHtml(input);
      expect(result).toContain("<b>Summary</b>");
      expect(result).toContain("<b>bold</b>");
      expect(result).toContain("<i>italic</i>");
      expect(result).toContain("<code>inline code</code>");
      expect(result).toContain('<pre><code class="language-js">');
      expect(result).toContain("<blockquote>");
      expect(result).toContain('<a href="https://example.com">docs</a>');
    });
  });

  describe("streaming partial text", () => {
    it("handles text with unclosed bold (no conversion)", () => {
      const result = markdownToTelegramHtml("start **bold without close");
      // Unclosed ** should not produce <b>
      expect(result).toBe("start **bold without close");
    });

    it("handles text with unclosed code fence and content", () => {
      const result = markdownToTelegramHtml("text\n```python\ndef x():");
      expect(result).toContain("<pre><code");
      expect(result).toContain("def x():");
    });

    it("incrementally extends correctly", () => {
      // Simulate streaming: first partial, then complete
      const partial = markdownToTelegramHtml("Here is `code");
      expect(partial).not.toContain("<code>");

      const complete = markdownToTelegramHtml("Here is `code` done");
      expect(complete).toContain("<code>code</code>");
    });
  });
});

describe("isTelegramParseError", () => {
  it("returns true for parse entity errors", () => {
    expect(
      isTelegramParseError({
        error_code: 400,
        description: "Bad Request: can't parse entities: ...",
      }),
    ).toBe(true);
  });

  it("returns false for other 400 errors", () => {
    expect(
      isTelegramParseError({
        error_code: 400,
        description: "Bad Request: message is too long",
      }),
    ).toBe(false);
  });

  it("returns false for non-400 errors", () => {
    expect(
      isTelegramParseError({
        error_code: 403,
        description: "Forbidden",
      }),
    ).toBe(false);
  });

  it("returns false for non-objects", () => {
    expect(isTelegramParseError(null)).toBe(false);
    expect(isTelegramParseError("error")).toBe(false);
    expect(isTelegramParseError(undefined)).toBe(false);
  });
});
