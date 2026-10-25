# @canadian-plans/ui

Shared shadcn/ui-based components and design tokens (colour, radius,
spacing, font — defined once) for every frontend. No content, no brand.

## Single responsibility

Give every frontend the same primitives so brand look-and-feel differences
live in each site's own theme layer, not in copy-pasted components.

## Must never import

- `@canadian-plans/db`, `@canadian-plans/adapters` — this package is bundled
  into the browser and must never carry a provider secret or DB code.
- Any app (`apps/*`).

## Accessibility additions

`CardTitle` accepts `asChild` so a page can render an `h1` while retaining shared styles. `SidebarInset` is a `main` landmark: do not nest another `main` inside it. `SidebarMenuButton` tooltips mount only in collapsed desktop navigation; invisible tooltip layers must not consume mobile Escape. Closing the mobile sheet restores focus to `SidebarTrigger`.

Focus outlines, palette, spacing, radius and font remain shared in `src/styles/tokens.css`. App-specific navigation and workspace labels belong in the app, not these primitives.
