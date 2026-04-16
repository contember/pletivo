# YAML Parser Limitations

**Priority:** B-tier
**Status:** Partial implementation
**Area:** Content Collections

## Problem

The built-in YAML frontmatter parser is minimal and doesn't support:
- Anchors and aliases (`&anchor` / `*anchor`)
- Multiline strings (`|`, `>`, `|+`, `>-`)
- Flow mappings and sequences (`{key: value}`, `[a, b, c]`)
- Complex keys
- Tags (`!!str`, `!!int`, etc.)

## Current State

- `packages/pletivo/src/content/` — custom minimal YAML parser
- Falls back to JSON parsing for flow syntax

## Expected Behavior

Either:
1. Use a proper YAML parser (`js-yaml`, `yaml`) as a dependency, or
2. Document the limitations clearly and reject unsupported syntax with helpful errors

## Notes

Option 1 is preferred — YAML edge cases are endless and a battle-tested parser avoids subtle bugs. The dependency cost is small.

## Files

- `packages/pletivo/src/content/` — YAML parsing code
