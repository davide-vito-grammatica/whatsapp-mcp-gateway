# Third-party notices and source materials

The root ISC license applies to original WhatsApp MCP Gateway source. Dependencies
and base-image components retain their upstream licenses and copyright notices.
The project license must not be read as replacing those terms for a combined
container distribution.

The proxy includes `libsignal` 6.0.0, declared GPL-3.0 by its upstream package.
Its JavaScript source and LICENSE are installed intact under
`node_modules/libsignal` in the proxy image. An unmodified GPLv3 text is also in
`licenses/GPL-3.0.txt`. Upstream source: https://github.com/WhiskeySockets/libsignal-node

Sharp 0.35.5 and optional @img platform packages include libvips and other native
components with Apache/MIT/LGPL and other upstream terms. The platform libvips
package version is 1.3.4. The proxy retains installed dependency files and license
notices; `licenses/LGPL-3.0.txt` supplies the LGPLv3 text alongside the GPLv3 text.
The upstream native-component source/build recipes and versioned release material
are at https://github.com/lovell/sharp-libvips/tree/v1.3.4 and
https://github.com/lovell/sharp/tree/v0.35.5 . Native component versions are recorded
in the installed @img package `versions.json`; its build recipes identify the
component source archives and patches. The open Docker build recipe and npm lock
permit rebuilding/replacing the dependency rather than restricting relinking.

MCP Python dependencies retain distribution license files in site-packages,
including dist-info/licenses where supplied. Pillow includes native image codecs
with their own notices. Node/Python/Alpine base-image source/build materials are
available through their upstream projects and Alpine package source repositories;
the Dockerfiles record exact base-image digests. No application dependency source
or license notices are intentionally stripped from the runtime image.

See [the complete pinned dependency inventory](https://github.com/davide-vito-grammatica/whatsapp-mcp-gateway/blob/main/docs/DEPENDENCIES.md). The npm
lockfile records exact registry artifacts and integrity values; Python versions
are pinned in `mcp/requirements.txt`. When redistributing or modifying combined
images, review the actual component terms and provide the required notices/source
materials; original-source ISC metadata does not waive upstream obligations.
