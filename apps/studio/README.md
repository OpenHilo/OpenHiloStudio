# @openhilo/studio

OpenHilo Studio's browser UI and static assets. The package consumes the `/api` service; it does not start a backend, choose providers or open a database.

Build from the repository root with `npm run build`. Static assets are written to `apps/studio/dist/client`; pass that directory to the server's `--studio` option. See the [root quick start](../../README.md).

`mountStudio` is also exported from `@openhilo/studio/client` for trusted build-time page/settings extensions. Service JSON describes data and capabilities; it cannot install executable UI code. Hosts adding extensions must preserve those extensions' notices.

The built UI includes local Monaco workers, syntax highlighting and third-party notices. Inputs and results wrap visually without changing their contents. Human drafts are saved in the browser for the same origin, task and iteration; accepted answers clear the draft. Unknown submission outcomes retain the original submission identity for safe retry.

See [workflow behavior](../../docs/workflows.md), [configuration](../../docs/configuration.md) and [contributing](../../CONTRIBUTING.md).

For a separate tarball consumer, preserve the root project's DOMPurify 3.4.17 override; see the [dependency advisories](../../docs/verification.md#dependency-advisories). The source installation already pins it.


### Application branding and workflow metadata

A host that builds its own frontend can import `mountStudio` from
`@openhilo/studio/client`. Its optional fourth argument sets the displayed name,
logo and browser title; the existing three-argument call remains supported.

```tsx
mountStudio(root, [], [], {
  name: 'Research Desk',
  logoUrl: '/assets/research-logo.svg',
  title: 'Research Desk',
});
```

The logo must use a same-origin absolute path. Omit it to display the name as
text. A failed image also falls back to the name. The host owns its static assets.
No HTML, CSS or executable components are accepted in this branding value.

Pass a `StudioApplication` descriptor through the server's `application` option
for data presentation. In addition to class facets and tag styles, the optional
`workflowFacet` selects a scalar workflow metadata field and its display labels;
`workflowFilterTags` selects tag filters in the workflow library. For example:

```ts
workflowFacet: {
  field: 'stage', label: 'Stage',
  values: [{ value: 'draft', label: 'Draft' }],
},
workflowFilterTags: ['team'],
```

These descriptors change presentation, not execution semantics or permissions.
Missing metadata stays unclassified, unknown values remain visible, and entity
classification is shown from the selected class rather than copied to records.
Business rules belong in the host's generation, compilation and runtime policies.
