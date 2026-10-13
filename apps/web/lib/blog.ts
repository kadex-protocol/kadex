export type BlogBlock =
  | { kind: "p"; text: string }
  | { kind: "h"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "figures"; items: { value: string; label: string }[] }
  | { kind: "links"; items: { label: string; note: string; href: string }[] }
  | { kind: "note"; text: string };

export type BlogTag = "Market" | "News";

export type BlogPost = {
  slug: string;
  tag: BlogTag;
  title: string;
  excerpt: string;
  date: string;
  minutes: number;
  cover: string;
  coverAlt: string;
  coverFocus?: string;
  credit: { text: string; href: string };
  blocks: BlogBlock[];
  sources: { label: string; href: string }[];
  cta: { label: string; href: string };
};

const DEVNET_APP = "https://web-devnet-production.up.railway.app";
const explorer = (address: string) => `https://explorer.solana.com/address/${address}?cluster=devnet`;

export const POSTS: BlogPost[] = [
  {
    slug: "the-16-5m-pokemon-card",
    tag: "Market",
    title: "A $16.5M Pokémon card, and the market behind it",
    excerpt:
      "Logan Paul's Pikachu Illustrator became the most expensive trading card ever sold at auction. The market around it moved on-chain, and it still has no way to go short.",
    date: "2026-10-12",
    minutes: 4,
    cover: "/blog/market.jpg",
    coverAlt: "Logan Paul at WrestleMania XL next to the PSA 10 Pikachu Illustrator slab",
    coverFocus: "23% 30%",
    credit: {
      text: "Photo: diegofernandophotography, CC BY 2.0, via Wikimedia Commons. Card image added.",
      href: "https://commons.wikimedia.org/wiki/File:Logan_Paul,_WrestleMania_XL_in_2024_1.jpg",
    },
    blocks: [
      {
        kind: "p",
        text: "In February 2026 a PSA 10 Pikachu Illustrator owned by Logan Paul sold at Goldin for $16,492,000. Guinness World Records lists it as the most expensive trading card ever sold at auction. Paul had bought the card in 2021 for $5,275,000, which was already a record for a Pokémon card sold privately.",
      },
      {
        kind: "figures",
        items: [
          { value: "$16.49M", label: "Auction price, February 2026" },
          { value: "$5.28M", label: "What Paul paid in 2021" },
          { value: "97", label: "Bids in the auction" },
        ],
      },
      { kind: "h", text: "Why a piece of cardboard has a quotable price" },
      {
        kind: "p",
        text: "The card is graded. A grading company authenticated it, scored its condition out of ten and sealed it in a plastic case, the slab. The grade is what makes two copies comparable, and a comparable asset is one that can have a market price. Paul famously wore this slab on a diamond necklace, and it changed hands the same way: it was placed around the buyer's neck.",
      },
      { kind: "h", text: "The market moved on-chain" },
      {
        kind: "p",
        text: "Most of the market sits far below that price, and it is much more liquid than it used to be. Collector Crypt keeps graded cards in insured vaults and issues a token for each one on Solana. The token trades around the clock and can be redeemed for the physical card. The platform passed $1 billion in total volume about eighteen months after launching its pack product in December 2024.",
      },
      { kind: "h", text: "What is still missing" },
      {
        kind: "p",
        text: "With all of that, a card owner still has exactly one position available: own the card. A dealer holding $50,000 of inventory cannot protect it against a falling market, and selling means waiting for a buyer or taking a discount. Nobody who thinks prices are too high can take the other side.",
      },
      {
        kind: "p",
        text: "That gap is what Kadex is built for: a perpetual market on an index of graded cards. You can go long or short on the index with margin, without buying, shipping or storing a slab.",
      },
      {
        kind: "note",
        text: "Kadex is not affiliated with or endorsed by Logan Paul, Goldin, PSA, Guinness World Records or Collector Crypt. Figures come from the sources listed below.",
      },
    ],
    sources: [
      {
        label: "Guinness World Records: Logan Paul's rare Pokémon card becomes most expensive ever sold",
        href: "https://www.guinnessworldrecords.com/news/2026/2/logan-pauls-rare-pokemon-card-becomes-most-expensive-ever-sold-in-record-setting-auction",
      },
      {
        label: "Collector Crypt Chronicles: Collector Crypt surpasses $1 billion in volume",
        href: "https://collector-crypt.beehiiv.com/p/collector-crypt-surpasses-1-billion-in-volume",
      },
    ],
    cta: { label: "Trade the index", href: "/" },
  },
  {
    slug: "the-12-9m-jordan-kobe-card",
    tag: "Market",
    title: "Kevin O'Leary helped pay $12.9M for one basketball card",
    excerpt:
      "The Jordan and Kobe Logoman is the most expensive sports card ever sold. Nobody else can own a one-of-one, which is the case for an index.",
    date: "2026-10-12",
    minutes: 4,
    cover: "/blog/oleary.jpg",
    coverAlt: "Kevin O'Leary at PaleyFest 2023",
    credit: {
      text: "Photo: Philip Romano, CC BY-SA 4.0, via Wikimedia Commons. Cropped, background extended.",
      href: "https://commons.wikimedia.org/wiki/File:KevinOLeary2023.jpg",
    },
    blocks: [
      {
        kind: "p",
        text: "On 23 August 2025 a 2007-08 Upper Deck Exquisite Collection Dual Logoman Autographs card of Michael Jordan and Kobe Bryant sold at Heritage Auctions for $12,932,000. That is the most ever paid for a sports card. It passed the 1952 Topps Mickey Mantle that sold for $12.6 million in August 2022.",
      },
      {
        kind: "p",
        text: "The buyers were a group of three: Shark Tank investor Kevin O'Leary, collector Matt Allen and entrepreneur Paul Warshaw, as the auction house confirmed to ESPN. The auction drew 82 bids.",
      },
      {
        kind: "figures",
        items: [
          { value: "$12.93M", label: "Jordan and Kobe Logoman, August 2025" },
          { value: "$12.6M", label: "1952 Topps Mantle, August 2022" },
          { value: "82", label: "Bids in the auction" },
        ],
      },
      { kind: "h", text: "One card, one owner" },
      {
        kind: "p",
        text: "The card is numbered one of one. It carries both signatures and the NBA logo patches from jerseys the two players wore. There is exactly one of it, and it has owners now. For everyone else its price is something to read about, not something to trade.",
      },
      { kind: "h", text: "Why an index" },
      {
        kind: "p",
        text: "Record sales show that cards are treated as an asset class. An asset class needs a way to hold the market rather than one item, the way stock investors hold an index instead of one company. Kadex builds that for graded cards: one index over a fixed basket of ten professionally graded cards with fixed weights, where no card may weigh more than 15%.",
      },
      { kind: "h", text: "Where the index price comes from" },
      {
        kind: "p",
        text: "No signed feed and no administrator sets the price. The index is represented by one token that trades against the dollar token in an on-chain pool, and the price is recomputed from that pool by an instruction anyone can call.",
      },
      {
        kind: "list",
        items: [
          "Spot: the ratio of the pool's two reserves, read at most once per slot.",
          "Average: a time-weighted average over 30 minutes, so a price pushed for one transaction barely counts.",
          "Limit: the official price can move at most 5% per 15 seconds of elapsed time.",
        ],
      },
      {
        kind: "p",
        text: "Open interest is limited by two ceilings, and the lower one governs: the pool's liquid reserve, so winners can be paid, and the depth of the pricing pool, so that moving the price far enough to force liquidations costs more than it pays.",
      },
      {
        kind: "note",
        text: "Kadex is not affiliated with or endorsed by Kevin O'Leary, Heritage Auctions, Upper Deck or the NBA. Figures come from the sources listed below.",
      },
    ],
    sources: [
      {
        label: "ABC7 Chicago / ESPN: 'Holy grail' Jordan-Bryant sports card sells for record $12.9M",
        href: "https://abc7chicago.com/post/holy-grail-jordan-bryant-sports-card-sells-record-129m/17630443/",
      },
      {
        label: "CBS News Texas: one-of-a-kind Michael Jordan-Kobe Bryant card sells for a record $12.9 million",
        href: "https://www.cbsnews.com/texas/news/one-of-a-kind-michael-jordan-kobe-bryant-basketball-card-sells-for-a-record-12-9-million-from-dallas-auction",
      },
    ],
    cta: { label: "Read the index methodology", href: "/index-methodology" },
  },
  {
    slug: "pokemon-cards-beat-the-sp-500",
    tag: "Market",
    title: "Pokémon cards beat the S&P 500. One then lost 40% in six weeks.",
    excerpt:
      "A Pokémon card index is up 3,821% since 2004, and in 2026 single chase cards fell by a third or more. Prices that move both ways are what a short is for.",
    date: "2026-10-12",
    minutes: 5,
    cover: "/blog/shop.jpg",
    coverAlt: "The window of a trading card shop in Hsinchu, Taiwan",
    credit: {
      text: "Photo: Tbatb, CC BY-SA 4.0, via Wikimedia Commons. Cropped.",
      href: "https://commons.wikimedia.org/wiki/File:Window_of_a_Trading_Card_Shop_in_Hsinchu_City.jpg",
    },
    blocks: [
      {
        kind: "p",
        text: "An index of Pokémon card values compiled by the analytics firm Card Ladder returned about 3,821% from 2004 to August 2025. The S&P 500 gained 483% over the same period.",
      },
      {
        kind: "p",
        text: "The way up was never a straight line, and 2026 showed it. According to the price tracker Misprint, the Prismatic Umbreon ex, one of the most wanted modern cards, peaked near $1,550 in April 2025, fell below $1,000 in early 2026 and then recovered. A newer chase card, the Mega Greninja ex from Chaos Rising, opened near $505 in late May 2026 and traded around $300 six weeks later. Over the same year, vintage cards from 1999 to 2003 rose roughly 15% to 25%.",
      },
      {
        kind: "figures",
        items: [
          { value: "+3,821%", label: "Card Ladder Pokémon index, 2004 to August 2025" },
          { value: "+483%", label: "S&P 500, same period" },
          { value: "−40%", label: "Mega Greninja ex, six weeks in 2026" },
        ],
      },
      { kind: "h", text: "Who carries that risk" },
      {
        kind: "p",
        text: "A card shop's money sits in its inventory. When prices drop there are two options today. Sell, which means waiting for a buyer or taking a discount. Or hold, and stay exposed until the cards sell.",
      },
      { kind: "h", text: "The short as insurance" },
      {
        kind: "p",
        text: "A short position on the Kadex Index gains value when the index falls. If a dealer's cards move with the market, the gain on the short offsets the loss on the cards, and the net stays close to flat. The cards never leave the shelf.",
      },
      {
        kind: "p",
        text: "The trade ticket has a Hedge mode for this. Instead of an order size you enter the value of your inventory and choose how much of it to cover, and Kadex opens a short of that size. If your wallet holds tokenized cards, the app reads their value for you.",
      },
      { kind: "h", text: "What it costs" },
      {
        kind: "list",
        items: [
          "Margin: at 5x, a short that covers $10,000 needs $2,000 of margin.",
          "Fees: 0.1% of the position size to open and again to close.",
          "Borrow: charged while the position is open. The ticket shows it as the cost of cover per month.",
        ],
      },
      { kind: "h", text: "What it does not do" },
      {
        kind: "p",
        text: "The hedge follows the index, not your exact cards. If your cards fall more than the index, the difference is yours. A short can also be liquidated if the index rises far enough against it, and the ticket shows that price before you sign.",
      },
      {
        kind: "note",
        text: "The card prices above are examples from the sources below, not Kadex Index values. Kadex is not affiliated with Card Ladder, Misprint or The Pokémon Company.",
      },
    ],
    sources: [
      {
        label: "MarketScreener: How much does it cost? The card craze",
        href: "https://www.marketscreener.com/news/how-much-does-it-cost-the-card-craze-ce7e59d2d98ef226",
      },
      {
        label: "Misprint: Pokémon card market mid-2026",
        href: "https://www.misprint.com/posts/pokemon-card-market-mid-2026",
      },
    ],
    cta: { label: "Open the Hedge ticket", href: "/" },
  },
  {
    slug: "collector-crypt-passes-1-billion",
    tag: "News",
    title: "Collector Crypt passed $1 billion. The cards are already on-chain.",
    excerpt:
      "Graded cards trade as tokens on Solana around the clock. Kadex reads that market, and a vaulted card turns into fractions.",
    date: "2026-10-12",
    minutes: 4,
    cover: "/blog/vending.jpg",
    coverAlt: "A trading card vending machine at Montreal Central Station",
    credit: {
      text: "Photo: One of Many Tims, CC BY 4.0, via Wikimedia Commons. Cropped.",
      href: "https://commons.wikimedia.org/wiki/File:Gare_Centrale_distributeur_cartes_pok%C3%A9mon.jpg",
    },
    blocks: [
      {
        kind: "p",
        text: "Card packs now come out of vending machines in train stations, like the one above in Montreal. The on-chain version runs at any hour. Collector Crypt keeps professionally graded cards in insured vaults and issues one token per card on Solana. The token can be traded at any time and redeemed for the physical card.",
      },
      {
        kind: "p",
        text: "About eighteen months after launching its pack product in December 2024, the platform passed $1 billion in total volume, with more than 50,000 cards redeemed. In June 2026 it set a weekly record of 215,000 packs opened.",
      },
      {
        kind: "figures",
        items: [
          { value: "$1B+", label: "Total volume on Collector Crypt" },
          { value: "50,000+", label: "Cards redeemed for the physical card" },
          { value: "215,000", label: "Packs opened in one week, June 2026" },
        ],
      },
      { kind: "h", text: "What Kadex does with those cards" },
      {
        kind: "p",
        text: "Kadex reads Collector Crypt's marketplace directly. The Vault page lists real tokenized cards with their grade, certification number and appraisal, and every card has its own page.",
      },
      {
        kind: "p",
        text: "The index basket comes from the same place. It is ten cards chosen from live Collector Crypt listings: graded by PSA, Beckett or CGC, appraised between $1,000 and $6,000, with no card above 15% of the index.",
      },
      { kind: "h", text: "From a slab to fractions" },
      {
        kind: "p",
        text: "Vault a graded card and you receive fractions worth its appraised value. The card sits in an on-chain escrow. When you hold all of its fractions again, you can redeem the original card. On devnet you can try this with test copies of cards from the basket.",
      },
      {
        kind: "note",
        text: "Kadex is not affiliated with or endorsed by Collector Crypt, grading companies or card publishers. Card images belong to their owners.",
      },
    ],
    sources: [
      {
        label: "Collector Crypt Chronicles: Collector Crypt surpasses $1 billion in volume",
        href: "https://collector-crypt.beehiiv.com/p/collector-crypt-surpasses-1-billion-in-volume",
      },
      {
        label: "Solana Compass: Collector Crypt sets weekly pack record with 215K opens",
        href: "https://solanacompass.com/news/collector-crypt-sets-weekly-pack-record-with-215k-opens-crosses-50m-in-revenue",
      },
    ],
    cta: { label: "Browse the Vault", href: "/vault" },
  },
  {
    slug: "solana-perps-record-quarter",
    tag: "News",
    title: "Solana perps had a record $147B quarter. Cards are the missing market.",
    excerpt:
      "Perpetual futures on Solana set a record in Q2 2026. Kadex brings the same instrument to graded cards, and it is live on devnet.",
    date: "2026-10-12",
    minutes: 5,
    cover: "/blog/solana.jpg",
    coverAlt: "Anatoly Yakovenko, co-founder of Solana, on stage at TechCrunch Disrupt in 2025",
    credit: {
      text: "Photo: TechCrunch, CC BY 4.0, via Wikimedia Commons. Cropped.",
      href: "https://commons.wikimedia.org/wiki/File:Anatoly_Yakovenko.jpg",
    },
    blocks: [
      {
        kind: "p",
        text: "Perpetual futures on Solana reached $147 billion in volume in the second quarter of 2026, a record for the network, and $255.6 billion across the first half of the year. Volume was up 57.1% from a year earlier, with Drift and Jupiter Perps leading.",
      },
      {
        kind: "figures",
        items: [
          { value: "$147B", label: "Solana perps volume, Q2 2026" },
          { value: "$255.6B", label: "First half of 2026" },
          { value: "+57.1%", label: "Compared with a year earlier" },
        ],
      },
      { kind: "h", text: "The same instrument, for cards" },
      {
        kind: "p",
        text: "A perpetual future lets you take a long or a short position on a price with margin and no expiry date. You never hold the asset. On Kadex the price is an index of graded cards. Positions use isolated margin at 5x, and before you sign the ticket shows the margin required, the entry price and the estimated liquidation price.",
      },
      {
        kind: "list",
        items: [
          "Opening and closing each cost 0.1% of the position size.",
          "While the position is open you pay a borrow rate, which rises as more of the pool is in use.",
          "If losses bring the position below its maintenance margin, it is liquidated.",
        ],
      },
      { kind: "h", text: "Who takes the other side" },
      {
        kind: "p",
        text: "A pool does, the model used by Jupiter Perps and GMX. Deposit into it and you receive CLP, a token for your share of the pool, minted at the pool's net asset value. Fees and borrow paid by traders go to the pool. So do traders' losses, and traders' gains are paid out of it, which is the risk you take for the yield.",
      },
      { kind: "h", text: "Live on Solana devnet" },
      {
        kind: "p",
        text: "On 12 October 2026 Kadex went live on Solana devnet. A keeper refreshes the price every ten seconds and a liquidator closes positions that fall below their maintenance margin.",
      },
      {
        kind: "links",
        items: [
          { label: "oracle", note: "Computes the index price from the pool", href: explorer("5288ShBXsFxqXiGm22FZi1ZrMnmet4i1ZR3bccyAguqp") },
          { label: "clp_pool", note: "Holds the liquidity and mints CLP", href: explorer("3XZkAqLeQDoNXD6Bb9YoGSEdnvqk9r7UMgrKsN5x3L9v") },
          { label: "perp", note: "Positions, borrow and liquidation", href: explorer("BcVwJ91Jd1k7xUNcGYzRygq2ubaCYn7p5MeUZzy1EyLR") },
          { label: "card_vault", note: "Turns a graded card into fractions and back", href: explorer("J8Tef8N4YSfVwAxpBemCZrz3qCxehTeb2cd1jTwoBczW") },
        ],
      },
      {
        kind: "p",
        text: "To try it, open the devnet app, pick the demo wallet or connect your own wallet on devnet, and use the faucet for test SOL and kdUSD. kdUSD is a devnet test dollar, not USDC, and nothing on devnet has monetary value.",
      },
      {
        kind: "note",
        text: "Kadex is not affiliated with or endorsed by Anatoly Yakovenko, the Solana Foundation, TechCrunch, Drift or Jupiter. Figures come from the source listed below.",
      },
    ],
    sources: [
      {
        label: "Crypto Briefing: Solana achieves record $147B in perps trading volume in Q2 2026",
        href: "https://cryptobriefing.com/solana-record-perps-trading-volume-q2-2026/",
      },
    ],
    cta: { label: "Open the devnet app", href: DEVNET_APP },
  },
];

export const postBySlug = (slug: string) => POSTS.find((post) => post.slug === slug) ?? null;

export function fmtPostDate(iso: string) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
