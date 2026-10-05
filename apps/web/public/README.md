# Static assets

## `vault-hall.jpg`

The hero plate. A generated interior — stone hall, arched window, light shaft,
an empty vitrine on a plinth — used as the background of every `.hero`.

**Why this one and not the other reference.** The alternative plate had real
graded cards in it: Pokemon, Magic, Star Wars, a Jordan rookie. All legible,
all third-party trademarks. This plate has an *empty* case, so the repository
carries no one else's marks.

**How it is used.** `background-position: 68% 30%` puts the arch and the light
on the right, where the objects sit, and leaves the dark left wall for the
copy. A three-layer scrim in `.hero::after` guarantees the headline stays
readable at every window width — without it, display type sits on whatever the
photograph happens to be doing behind it.

Source is 1024x1536 PNG, 1.7 MB. Shipped as JPEG quality 68, ~162 KB.

To replace it, keep the same shape: dark and quiet on the left, light and
interesting on the right.
