# Reading workflow inputs and results

Open a step in **Activity**, or select a node in **Execution**, to inspect its inputs and results. The same viewer appears in Human-task summaries and workflow results.

Simple values appear as colored fields without JSON's outer braces and quotes. Long text wraps inside the panel. Empty strings, empty objects, empty arrays, `null`, `false`, zero and missing values have distinct representations.

## Nested data and large arrays

Expand an object or array to inspect its children. Large collections are grouped into expandable ranges after 25 items, so you can reach later entries without opening every item. Deeply nested collections start collapsed. Long strings have an expand control, and collection controls can receive keyboard focus.

Complex values also offer a **raw JSON** view. Use it when you need the exact JSON structure rather than the field presentation. JSON-encoded strings stay strings: Studio does not implicitly parse or transform their contents. Display formatting does not change saved inputs, outputs or recovery data.

## For contributors

The tree view uses [react-json-tree](https://github.com/reduxjs/redux-devtools/tree/main/packages/react-json-tree); Studio provides styles and controls. Values render as text, not HTML. The frontend tests cover multiline text, escaping, nesting, large collection ranges, empty values and source-data immutability. Raw JSON must match `JSON.stringify` of the original value.

When changing the viewer, test nested objects, large mixed arrays, long text in different languages, empty values and HTML-like literal text. Verify expansion, field/raw switching, keyboard focus and narrow-screen wrapping. See [testing](verification.md) for the full check suite.
