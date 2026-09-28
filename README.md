# Quick @see Links

Turns comments like

```js
// @see ../php/path/class.php:123
// @see aha/php/db/read_ext/class.x_grid_data.php#x_grid_data.fetch
```

into clickable links in **any file type**. Ctrl/Cmd-click jumps straight to the target file, line or method. It works the same in `.js`, `.php`, `.py`, `.sql`, `.md`, config files and anything else.

## Supported syntax

```
@see path/to/file.ext
@see ../relative/path/to/file.ext:123       line 123
@see ../relative/path/to/file.ext:123:5     line 123, column 5
@see path/to/file.php#fetch                 function / method / variable named "fetch"
@see path/to/file.php#x_grid_data.fetch     method "fetch" of class "x_grid_data"
@link ./other-file.txt
```

- A path is looked up **relative to the file containing the comment** first, then **relative to each workspace folder**.
- A path starting with `/` is resolved from the **workspace root** (configurable, see below).
- An absolute path that exists is used as-is.
- If the target file can't be found, no link is created, so a typo never offers to create a new file.

### Links to a symbol (`#name`)

`#a.b.c` is looked up in the target file's outline, the same list shown in the Outline view, which your language extension provides. If the chain isn't found, the last name is looked up anywhere in the outline. If that fails, a plain text search for `function name` or `name(` is used. Symbol links keep working when the code moves around.

## Copy @see Link

Right-click in any editor and choose **Copy @see Link**. A link to the spot under the cursor is copied to the clipboard, with the path relative to the workspace root:

| Cursor | Copied |
|---|---|
| Inside method `fetch` of class `x_grid_data` | `@see aha/php/.../class.x_grid_data.php#x_grid_data.fetch` |
| On a word outside any outline symbol | `@see path/file.js#word` |
| On empty space | `@see path/file.js:42` |

The tag used is the first entry of `quickSeeLinks.tags`.

## Configuration

```jsonc
{
  // Which tags trigger a link. Add your own, e.g. "@ref".
  "quickSeeLinks.tags": ["@see", "@link"],

  // If false, a leading "/" is treated as the filesystem root instead of the workspace root.
  "quickSeeLinks.rootRelativePrefix.enabled": true
}
```

## Known limitations

- Paths can't contain spaces, `:` or `#`.
- Windows drive paths (`C:\...`) are not supported in comments; use relative or workspace-root paths.
- Symbol links depend on the language extension for the target file providing an outline. Without one, only the text-search fallback is used.
