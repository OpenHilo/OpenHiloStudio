# Security

OpenHilo Studio is a trusted, local, single-user workflow host. It is not a multi-tenant service and does not provide a complete authentication or authorization boundary. Bind to loopback by default. Do not expose it directly to a public network. The HTTP API does not enforce application-level authentication. By default it accepts Host headers for localhost and IP literals, and rejects browser mutations from other origins (including opaque origins and cross-site Fetch Metadata). Additional DNS hosts require explicit `allowedHosts`; cross-origin browser clients require explicit `corsOrigin`. These checks reduce browser cross-site and DNS-rebinding exposure, but are not user authentication or network isolation. Native clients can omit browser headers, and a configured trusted origin/host is part of the trust boundary. Avoid `corsOrigin: true`, which deliberately permits every valid HTTP(S) browser origin.

Workflows can execute AI tools, Bash/Python and host-provided system operations with the service user's permissions. An AI adapter's sandbox does not sandbox Code nodes or arbitrary host tools. Review generated source and tools before approving or running workflows. Use a dedicated account and restricted workspace for untrusted inputs.

Configuration, workflow data, run snapshots, outputs and AI questions can contain sensitive information. Keep deployment homes and credentials outside the source checkout; do not commit them. API-key settings reference environment variables rather than storing keys in workflow source.

Stop requests are cooperative. External tools may have already caused effects or may take time to exit. Failed-step recovery can retry an incomplete step; completed checkpointed steps are retained, but arbitrary external effects inside the failed step are not transactional.

Do not post credentials, personal prompts, private run logs or exploit details in public issues. Check the repository's [Security page](https://github.com/OpenHilo/OpenHiloStudio/security) for a private reporting option. If it is unavailable, open an issue asking for a private maintainer contact without including vulnerability details.
