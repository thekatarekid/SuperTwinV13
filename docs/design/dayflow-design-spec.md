# Dayflow Design System Spec (from 31 app screenshots + Dayflow Swift source)

## EXACT values confirmed from the Dayflow repo (override estimates below where they conflict)

- **Fonts (bundled TTFs in the real app):** `Instrument Serif` (Regular + Italic) for ALL display/headings/expressive text (onboarding titles 36pt, page date header 26pt, section headers 20pt, pill button labels 18pt, donut center stat 16pt). `Figtree` (variable) for ALL body/UI text (card titles 15–16, body 12–13, chips 11–12, tiny labels 8–9 bold). Bundle via `@fontsource/instrument-serif` and `@fontsource/figtree` npm packages — NO CDN links (app must be self-contained/offline).
- **Primary accent orange:** `#F96E00` (selected sidebar icon/label, badges). **Primary CTA fill:** `#FF6B05` (solid orange button, white text, radius 12, inner 1.5px white @17% inset stroke). Toggle-on gradient end `#FF7506`. Progress ring fill `#FF8D40` on track `#FFC8A0 @30%`.
- **Background:** warm cream-to-peach painterly gradient washed with `#FAF5ED @40%`. Surfaces: `#FFFBF8` (cards), `#FFF8F2` (toasts), `#FDF8F1`, `#FAF7F5`.
- **Peach chrome:** header pill fill `#FFEBD3 @79%`, segmented bg `#FFEFE4`, hairlines `#F2D2BD`/`#F3D9C2`, selected-segment gradient `#FFB18D→#FFA46F`, pause-pill border `#FFE1C9`.
- **Text:** primary `#333333`; secondary `#666666`/`#8C8C8C`; warm chrome labels `#786655`/`#796E64`; unselected sidebar items warm brown `rgb(153,102,77)`; deep orange-browns on peach `#C04A00`, `#89380E`, `#492304`; dark button fill near-black brown `#402C00`.
- **Category colors (exact defaults):** `#6A7EFF`, `#56CFEE`, `#C787F7`, `#FFAE8C`, `#FF4721`, `#ADE3E3`.
- **Radii:** capsule/999px pills are the signature control shape; 12 buttons/toasts/modals; 8 dark CTAs/option cards; 6 chips; 5 inputs.
- **Shadows (buttons, triple-layered):** `0 0.5px 0.25px rgba(0,0,0,.25), 0 1px 0.5px rgba(0,0,0,.16), 0 2px 6px rgba(0,0,0,.30)`; cards/toasts `0 6px 12px rgba(0,0,0,.12)`; warm-tinted shadows (`#AF7246 @12%`, `#E89A6C @18%`) on peach chrome.
- **Motion:** springy micro-interactions everywhere — hover scale 1.02, press scale 0.97, pointing-hand cursor on all controls; staged entrance animations. In CSS: `transform 0.24s cubic-bezier(0.34,1.3,0.64,1)`-style transitions.
- **Sidebar:** narrow rail, ~62px square items, 17–18px icon above 12px Figtree label, selected = orange `#F96E00` with soft glow tile behind icon; unselected warm brown.



Source of truth for the SuperTwin UI revamp. Apply this to the SuperTwin app (React + one global `src/styles.css`), mapping SuperTwin's tabs (Inbox, Spaces, Agent, Digest, Chat, Settings) onto Dayflow's visual language.

## 1. Color Palette

### Backgrounds
- Base canvas: white to warm cream, `#FFFFFF` fading into `#FDF6EE`
- Signature ambient gradient: every screen sits on a soft radial/cloud gradient of warm peach glowing from edges/bottom: cream `#FBF3E8` → pale peach `#F8E3CC` → apricot `#F3CFA4`. Hero/empty screens intensify to golden yellow `#F5D98B` → orange `#EFA94E`
- App chrome: warm off-white `#FAF3EA`; left sidebar shares this and blends seamlessly (no hard divider), peach gradient bleed at bottom-left
- Card/panel surface: `#FFFFFF` and near-white `#FEFCFA`
- Subtle fill (inputs, wells): `#F5EFE7` / `#F1E9DE`

### Brand / accent
- Primary orange (accent): `#E8843A` (logo petals span `#F2B33D` → `#E8843A` → `#D9622B`)
- Orange tint fill (selected/hover): `#FBE8D7` – `#F9DFC8`
- Orange border (selected): `#EFA96B`
- Progress ring / sliders: `#EF8B45` on track `#F3E5D5`

### Text
- Display headings (serif): deep brown `#4A2E1E` to near-black ink `#241C14`
- Body / primary: `#3D3529`
- Secondary: `#7A6F60`
- Muted/disabled: `#B5A893`
- On dark buttons: `#FFFFFF` / `#F5EDE2`

### Dark action color
- Primary CTA brown (espresso): `#3E3012` – `#40331A`, hover slightly lighter; used for primary CTAs

### Category dot colors (use for Spaces / tags)
- Periwinkle `#6E6EE8`, sky `#5BC8DF`, peach `#F0A57D`, vermilion `#E8492A`, mint `#A8DCD3`
- Extras: purple `#9B5CF0`, magenta `#E85CC8`, coral `#E86055`, gold `#F0C75A`, lime `#AFF05A`, green `#5CF08A`, cyan `#5AF0F0`, blue `#5A78F0`

### Semantic
- Success green `#3E9B4F`, badge fill `#D9F2DC`
- Error: text `#D0453A` on `#FBDBD7`
- Info blue (toggles): `#3D7BF7`
- Focus header periwinkle `#7B8CF0`; limit header soft red `#E8767B`

## 2. Typography
- Display serif for headings/emotional moments: high-contrast editorial serif (Instrument Serif class — use "Instrument Serif" via bundled font). Regular weight, tight tracking. Hero ~40–48px; page titles ~30–34px; panel titles ~24–26px; modal titles ~24px.
- Sans body: geometric-humanist sans (Figtree class — use "Figtree" bundled, fall back to system).
  - Section headings: 20–22px semibold, near-black
  - Body: 14–15px regular `#3D3529`
  - Secondary/caption: 12–13px `#7A6F60`
  - Labels: 12px, +6% letter-spacing, uppercase, muted
  - Buttons: 14–15px medium/semibold
- Serif is reserved for emotional/branded moments; functional flows stay sans.

## 3. Layout
- Left icon sidebar (~72px): logo avatar (36px circle, white ring) top; nav items = icon (18px) + 11px label beneath. Inactive = warm gray-brown `#8A7B6A`; active = orange `#E8843A` icon+label on white/near-white rounded square (~40px, radius 10px, faint shadow).
- Main content area: white rounded panel (radius ~16px) floating inside the warm gradient shell, inset ~12px from window edges.
- Right panel pattern: fixed ~430px, white, sections separated by 1px `#EFE6D9` dividers.
- Settings layout: serif "Settings" title; left subnav (~200px): 15px text items, active = dark text on light gray-beige pill `#EFE9E0` radius 10px; content column max ~900px, 20px section headers, hairline-separated rows. Version pinned bottom-left.

## 4. Components
- Primary button (dark): espresso `#3E3012`, white text, radius 10–12px, padding 12×24px, subtle shadow. Disabled = 40% opacity.
- Secondary button: white fill, 1px `#DCD2C4` border, dark text, radius 10px.
- Tonal button: orange-tint fill `#F9DFC8` with darker text.
- Segmented control: capsule container white/cream 1px border; active segment = orange gradient pill `#F2A45E→#E8843A`, fully rounded, height ~32px.
- Chips: white pill, 1px `#E8DFD2` border, radius 999px, 8px colored dot + 14px medium label.
- List cards: white, radius 12px, faint shadow; colored left bar (3–4px) for categorized items; time/meta right-aligned 13px gray.
- Shimmer/generating card: animated purple→orange gradient at ~40% opacity.
- Donut chart: thick ring, category colors, center white with uppercase caption + serif numerals, soft shadow.
- Progress bars: 6px rounded track `#EDE4D6`, category-color fills.
- Modal/overlay: page behind blurred + desaturated; centered card `#FBF4EA` radius 20px, soft shadow, serif title, capsule stat pill (orange text, 1px orange border), dark CTA.
- Empty/locked states: full-bleed warm gradient, serif title + orange "BETA"-style ticket tag rotated ~8°, white info card (radius 16px, shadow), disabled capsule button gray `#D8D2C8`.
- Pricing-style cards: white radius 12px 1px border; selected = beige fill `#EFE7DB` + dark 1.5px border + beige badge.
- Status badges: capsule, tinted bg + colored text (green "Installed", red "Not installed", gray-beige neutral).
- Toggles: iOS-style, blue `#3D7BF7` on, gray-beige off.

## 5. Spacing, Radii, Shadows, Feel
- Spacing scale: 4/8/12/16/24/32/48; page padding 32–48px; card padding 16–24px.
- Radii: buttons 10–12px; cards/rows 12px; panels/modals 16–20px; pills 999px; nav tile 10px.
- Shadows: `0 2px 8px rgba(90,60,20,0.06)` cards; `0 8px 30px rgba(90,60,20,0.12)` modals; CTAs `0 2px 6px rgba(62,48,18,0.25)`.
- Borders: hairlines `#EFE6D9`; component borders `#E4DACB`.
- Feel: warm, editorial, sunrise-toned; serif-for-delight + sans-for-function; soft depth, no hard blacks (brown-shifted), blurred-glow gradients not flat fills.

## 6. Screen patterns to reuse in SuperTwin
- Main screen w/ right panel (Timeline) → Inbox / Digest layouts
- Settings w/ left subnav → Settings tab
- Gated/empty gradient states w/ serif + ticket tag → empty states (no WhatsApp connected, no spaces yet)
- Chip rows + colored dots → Spaces categories
- Timeline cards w/ left color bar → message/task/run list rows
- Donut + progress bars → Digest stats
- Wizard w/ left step list + progress ring → WhatsApp onboarding QR flow
- Report screen (serif thank-you + button row) → simple utility pages
