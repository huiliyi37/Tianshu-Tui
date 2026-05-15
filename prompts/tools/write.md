## Write File Tool

Create or overwrite a file. Creates parent directories automatically.

### Usage
- Prefer edit_file for targeted changes to existing files
- Use write_file only for new files or complete file rewrites
- Always provide absolute file paths
- File content is the complete file contents, not a diff
- Parent directories are created if they don't exist

### Examples
Good: `write_file(file_path="/abs/path/src/new-component.tsx", content="...full file content...")`
Bad: using write_file to change one line in an existing file (use edit_file instead)
