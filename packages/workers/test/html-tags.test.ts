import { describe, expect, test } from "bun:test";
import { attributeValue, htmlTags } from "../src/html-tags.ts";

function tagNames(html: string): string[] {
  return [...htmlTags(html)].map((tag) => `${tag.closing ? "/" : ""}${tag.name}`);
}

describe("htmlTags", () => {
  test("skips comments, doctypes and what script, style, title, textarea and template hold", () => {
    const html =
      "<!DOCTYPE html><html><head><!-- </head> --><title></head></title>" +
      '<script>document.write("</head><body>")</script><style>a::after { content: "</head>"; }</style>' +
      "<template><body></body></template><textarea></head></textarea></head ><BODY class=x></body></html>";
    expect(tagNames(html)).toEqual([
      "html", "head", "title", "/title", "script", "/script", "style", "/style",
      "template", "/template", "textarea", "/textarea", "/head", "body", "/body", "/html",
    ]);
  });

  test("reads a `>` inside a quoted attribute as part of the tag", () => {
    const [tag] = [...htmlTags('<script data-x="a>b" src=\'/s.js\'></script>')];
    expect(tag?.source).toBe('<script data-x="a>b" src=\'/s.js\'>');
    if (tag === undefined) throw new Error("no tag");
    expect(attributeValue(tag, "src")).toBe("/s.js");
    expect(attributeValue(tag, "type")).toBeNull();
  });

  test("stops at an unterminated comment or raw-text element", () => {
    expect(tagNames("<p><!-- </head>")).toEqual(["p"]);
    expect(tagNames("<script></head>")).toEqual(["script"]);
  });
});
