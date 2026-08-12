---
title: A page with no build step
date: 2026-01-12
description: What a Worker actually does between your keystroke and the HTML it returns.
tags: [rendering, workers]
---

A static site generator normally works in two phases: a build turns sources into
files, and a server hands those files out. This playground has no first phase. The
request itself is the build, and it only builds the one page you asked for.

## What a request does

1. Match the pathname against the files under `src/pages`.
2. Walk the imports of the page that matched, and compile only what that walk reaches.
3. Run the compiled modules and collect the HTML.
4. Generate the CSS for the classes that HTML actually used.

Step two is why this stays fast. A page here pulls in a layout, a component or two
and the content config — roughly a dozen modules, not the whole project. Editing a
post never touches the modules a different page compiled, so those stay warm.

## What it costs

Compiling on demand means the first request for a page pays for it. The second one
does not: compiled modules are cached by source text, so an edit invalidates exactly
the files you changed and nothing else.

The trade is worth it here because the input changes constantly. On a site that is
published once and read a million times, you would want the opposite — build
everything up front and never compile again. Both models render the same sources;
they just disagree about when.
