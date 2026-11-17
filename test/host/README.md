# Buzz host styles for integration fixtures

`buzz.css` compiles the Apache-2.0 design-system styles from
https://github.com/block/buzz-app/tree/v1.0.4/src/shared/design-system/styles
with Tailwind CSS 4.1.17. It includes Buzz's controls, pane headers, navigation,
form recipes, color roles, type roles and spacing. The fixture adds only host
layout and the font-face; Meetings ships only its own scoped layout CSS and
uses the running host's styles. This fixture does not establish native webview
capture or app activation behavior.

`inter.woff2` is Inter Variable Latin from @fontsource-variable/inter 5.2.8,
licensed under the SIL Open Font License; see INTER_LICENSE.txt.
