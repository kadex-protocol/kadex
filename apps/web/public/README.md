# Static assets

Cropped from the project's own reference renders. Source PNGs are 1024x1536
and live outside the repository; what ships here is the cropped, compressed
result.

## `vault-hall.jpg` — the hero plate

A landscape band (1024x730, 85 KB) cut from the reference: dark hall and bust
on the left, arched window and light shaft on the right, four graded cards on
a stone plinth.

`background-position: 62% 46%` keeps the cards and the light in frame while
the dark left wall carries the copy. The hero is a single 52%-wide column of
text over the full-bleed plate.

A two-layer scrim in `.hero::after` sits between plate and content. Without
it, display type lands on whatever the photograph is doing behind it, which
breaks at some window widths and not others.

## Card faces

The basket's card faces are Collector Crypt's own photos of the real cards
(`image` in `deployments/basket.json`). The acrylic case, certification label
and barcode around them are drawn in CSS.

## Replacing them

Keep the shape. The plate wants to be dark and quiet on the left, lit and
interesting on the right.
