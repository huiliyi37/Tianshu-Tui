## Edit File Tool

Perform exact string replacements in existing files.

### Usage
- Read the file first before editing
- old_string must be unique in the file — include surrounding context if needed
- Preserve exact indentation (tabs/spaces) from the file
- Use replace_all to replace every occurrence of old_string
- Prefer editing existing files over creating new ones

### Examples
Good: reading the file, finding the exact string with surrounding context, then replacing
Bad: editing without reading the file first
Bad: using a too-short old_string that matches multiple locations
