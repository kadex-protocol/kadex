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

## `cards/*.jpg` — the five faces

Charizard, Pikachu, Black Lotus, Jordan, Skywalker. Each is the card face
only, 280x392 (5:7), ~15-20 KB.

The acrylic case, certification label and barcode around them are drawn in
CSS, so a crop only ever has to supply the face. That is what lets the same
file work at 38px in a table and at 128px on the shelf.

## Replacing them

Keep the shapes. The plate wants to be dark and quiet on the left, lit and
interesting on the right. The faces want to be 5:7 with no case edges.

These are illustrative renders standing in for the real tokenized assets a
live index would hold.
