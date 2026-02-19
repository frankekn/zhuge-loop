---
name: Preset Request
about: Request a new preset for a specific workflow
title: '[Preset] '
labels: enhancement, preset
---

## Preset Name

e.g., `django`, `rust-cargo`, `monorepo`

## Project Type

What kind of project would use this preset?

## Suggested Config

```json
{
  "name": "my-preset",
  "profileRotation": ["default"],
  "profiles": {
    "default": {
      "description": "...",
      "phases": [
        { "id": "...", "command": "...", "timeoutMs": 600000 }
      ]
    }
  }
}
```

## Test Command

What command verifies the project is working? (e.g., `cargo test`, `python -m pytest`)
