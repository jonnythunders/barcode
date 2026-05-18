# Product Requirements Document — Barcode Brand Intelligence Platform

*Signal Triangulation Tool for a Consumer Goods Rep Group*

| | |
|---|---|
| **Client** | Barcode (consumer goods rep group) |
| **Status** | Pre-build — student prototype exists, largely starting fresh |
| **Engagement model** | $1,000/mo retainer, first month free post-launch |
| **Primary users** | Barcode sales team — internal use, not client-facing initially |

---

## 1. Background & Business Context

Barcode is a consumer goods rep group that connects emerging brands with major retail buyers (primarily Target). Their competitive advantage has historically been discovery — being the first to identify and pitch promising new brands before competing rep groups.

That edge has eroded. Social media has made brands findable before trade shows even happen. Barcode needs a systematic, data-driven way to find and evaluate emerging brands faster and more comprehensively than their competitors.

> **The Core Problem**
>
> "We used to go to a trade show and find a brand who was new — we were the first to talk to them. That's no longer the case. Everybody is found online / on social and contacted before trade shows even happen. We need this to be first. To be the best at finding new brands."

Barcode already has a meaningful data stack: SmartScout (Amazon intelligence), Nielsen/IRI monthly reports, Exploding Topics (trend detection), and some social signal monitoring. What they lack is a system that synthesizes these signals automatically and surfaces actionable insights to their sales team on a regular cadence.

A group of University of Minnesota students built a partial prototype — a social scraper that identifies brand follower counts. The students are graduating and the project is incomplete. We are taking over, reviewing the student code (likely throwaway), and building the real product.

## 2. Product Overview

The Barcode Brand Intelligence Platform is a three-module tool that triangulates social signals, Amazon product data, and retail scan data to give Barcode's sales team a decisive intelligence advantage.

| Module | Name | What It Does |
|---|---|---|
| **Module 1** | **Brand Card (On-Demand Lookup)** | Enter a brand name → instant snapshot of TikTok/IG social presence, Amazon performance, Google Trends, sentiment. Pre-call intelligence in under 30 seconds. |
| **Module 2** | **Weekly Scouting Report (Automated)** | Per-salesperson, per-category automated report delivered weekly (email/Slack). Surfaces emerging brands with high growth velocity before competitors find them. This is the trade show replacement. |
| **Module 3** | **Monthly Category Deep Dive (Semi-Automated)** | Monthly synthesis of Nielsen/IRI upload + social signals + SmartScout + Exploding Topics into a category landscape report. Cross-references retail velocity with social presence to find the 'call now' quadrant. Formatted for Target buyer meetings. |

Build order: Module 1 → Module 2 → Module 3. Deliver Module 1 first to demonstrate immediate value and build trust.

## 3. Data Sources & Access Strategy

The platform triangulates across 8+ data sources. Below is the full picture including access route, feasibility, and implementation approach.

| Signal | Source | Access Route | Status | Notes |
|---|---|---|---|---|
| TikTok followers + engagement | TikTok Developer API | Standard dev app (apply) | ✅ | developers.tiktok.com. 1–2 wk approval. Follower count, video stats, profile data for public accounts. |
| TikTok ad intelligence | Commercial Content API | Separate application (2-day approval) | ✅ | Ad reach, frequency, targeting. Signals brand investment level. Apply simultaneously with standard dev app. |
| TikTok category discovery | Scraper + hashtag API | Scraping public pages | ✅ | Hashtag → brand discovery. TikTok Research API explicitly excludes commercial use — do NOT apply for this. |
| TikTok Shop sales signals | TikTok Shop Open Platform | Separate partner application | ⚠️ Partial | Public Shop pages show 'X sold' — scrapeable now. Full API requires commerce partner approval. |
| Instagram follower count | Meta Business Discovery API | Developer app + review (1–2 wks) | ✅ | Count only for public Business/Creator accounts. No demographics. No growth history — build your own via weekly polling. |
| Instagram growth trend | Internal DB (weekly snapshots) | Build your own time series | ✅ | Poll Instagram weekly, store count + timestamp. |
| Amazon rating + review count | Public page scraper | Scraping (no auth needed) | ✅ | Star rating, review count, BSR rank, 'X bought in past month' badge. Most reliable at this scale. |
| Amazon category landscape | Category page scraper | Scraping top 100 SKUs/category | ✅ | Top products in relevant categories, weekly schedule. Brand, rank, rating, sales badge. |
| Amazon brand intelligence | SmartScout API | Enterprise plan required (~$399/mo) | ⚠️ Partial | Barcode's cost. Ask their plan tier. Enterprise unlocks API + Data Lake. |
| Trend signals | Google Trends (pytrends-equivalent) | Unofficial library (industry standard) | ✅ | No account. Brand + category keyword tracking. |
| Trend signals | Exploding Topics API | Business plan ($249/mo) | ⚠️ Partial | Barcode likely pays already. Confirm tier. |
| Retail scan data | Nielsen/IRI/Circana upload | File ingestion (CSV/Excel) | ✅ | Barcode uploads their monthly report. Build flexible ingestion. No API. |
| Community signals | Reddit API (snoowrap) | reddit.com/prefs/apps | ✅ | Early-signal brand mentions. Instant approval for script-type apps. |
| Sentiment analysis | AI layer (Claude) | Anthropic API | ✅ | NLP on pulled comments (TikTok, Reddit, Amazon reviews). Your core value-add layer. |
| X/Twitter signals | Grok API (xAI) | xAI API access | ⚠️ Partial | Use Grok as proxy for X trends rather than X's own heavily paywalled API. |
| DTC brand signals | Shopify store detection | Scraping public Shopify pages | ✅ | `/collections/all?sort_by=best-selling` is publicly accessible. Real sales rank pre-retail. |

## 4. Module 1: Brand Card — Detailed Spec

> **The User Story**
>
> A Barcode sales rep is about to get on a call with a brand called 'Vacation Sunscreen.' They type the brand name into the tool and get back a one-page snapshot: social presence, Amazon performance, trending data, and an AI-generated sentiment summary. Total time: under 30 seconds. No logging into Instagram. No Googling. No SmartScout tab-switching.

### 4.1 Input
- Brand name (text field)
- Optional: known social handles (if auto-resolution fails)
- Optional: Amazon brand name if different from social name

### 4.2 Handle Resolution

The system must map brand name → social handles + Amazon seller/brand page. This is non-trivial and is one of the harder technical problems.

- **Strategy 1**: Google Search — search `[brand name] site:tiktok.com` and `[brand name] site:instagram.com` to find handles
- **Strategy 2**: TikTok search API — search brand name, take top result
- **Strategy 3**: Amazon search — search brand name, look for brand-name-matched seller
- **Strategy 4**: Manual override — prompt user to enter handle if auto-resolution fails
- Store resolved handles in DB so repeated lookups skip this step

### 4.3 Data Fields — Brand Card Output

| Section | Field | Source | Notes |
|---|---|---|---|
| TikTok | Follower count, following, likes, video count, bio, verified | TikTok Developer API | Once approved. Follower count + video count are primary signals. |
| TikTok | Top 3 videos: views, likes, shares, comments | TikTok Developer API | Engagement rate context beyond raw follower count. |
| TikTok | Ad presence + estimated reach | Commercial Content API | Signal: is the brand investing in paid TikTok? |
| Instagram | Follower count, bio, post count | Meta Business Discovery API | Count only. Requires Business/Creator account on brand side. Store weekly. |
| Instagram | Follower trend line (week over week) | Internal DB (your weekly polls) | Growth velocity derived from your own polling. Start polling NOW. |
| Amazon | Star rating, review count, BSR rank, 'X bought in past month' badge | Public page scraper | 'X bought' is real Amazon data — often better than estimated sales. |
| Google Trends | Search volume trend for brand name, 12-month view | google-trends-api | Industry standard. Are people searching for this brand? |
| AI Sentiment | Comment sentiment summary, top praise themes, top complaints | Claude API on TikTok/Reddit comments | Pull recent comments → batch send to Claude for structured sentiment. |

### 4.4 Output Format
- Primary: structured JSON response (for rendering in UI or further processing)
- Secondary: formatted email-ready summary (for sharing pre-call)
- Stretch: PDF export of brand card

### 4.5 Example Output — Vacation Sunscreen

> **SOCIAL**: TikTok 847K followers (+12% MoM), avg engagement 4.2%. Instagram 312K followers (+8% MoM).
>
> **AMAZON**: 4.6 stars (2,847 reviews), BSR #3 in Sun Care, '1,000+ bought in past month.'
>
> **TRENDS**: Google search volume up 340% YoY. Reddit mentions up 65% in r/SkincareAddiction past 30 days.
>
> **SENTIMENT**: Overwhelmingly positive. Top praise: 'reef-safe formula,' 'no white cast,' 'smells great.' Top complaint: 'price point.'
>
> **AI SUMMARY**: Vacation is a high-momentum DTC brand with strong community enthusiasm and accelerating retail velocity. Social growth and Amazon rank both trending upward. Sentiment is excellent. Worth prioritizing for Target pitch.

## 5. Module 2: Weekly Scouting Report — Detailed Spec

> **The User Story**
>
> Every Monday morning, each Barcode sales rep receives an email with their Weekly Brand Radar for their assigned categories. It surfaces brands they haven't heard of, ranked by momentum score. Brands with high social growth + Amazon presence + no current Nielsen/IRI retail presence are flagged as 'Call This Week.' This is the trade show replacement.

### 5.1 Discovery Engine — How It Finds New Brands

The harder technical problem. The system must discover brands it doesn't already know about. Signal layers in order of implementation:

- **TikTok hashtag crawler** *(Layer 1, Week 1–2)*: For each category, maintain a list of relevant hashtags. Pull top posts under those hashtags → extract creator/brand accounts → filter by follower count threshold (>10K). Any new brand account not already in the DB is a candidate.
- **Amazon category top 100 scrape** *(Layer 2, Week 2–3)*: Scrape top 100 products in target categories weekly. Extract brand names → resolve to social handles → add to monitoring queue.
- **Reddit mention monitoring** *(Layer 3, Month 2)*: Monitor relevant subreddits for new brand mentions not already in DB. Brand first mentioned in r/SkincareAddiction with positive sentiment → flag for human review.
- **Shopify bestseller scrape** *(Layer 4, Month 2–3)*: Identify DTC brand sites (Shopify URL patterns). Pull `/collections/all?sort_by=best-selling` for real sales rank signals.
- **Exploding Topics API feed** *(Layer 5, Month 3)*: Pull trending startups/brands. Match against social accounts in target categories.

### 5.2 Momentum Score

Each brand in the discovery engine gets a Momentum Score (0–100):

| Signal | Weight | Notes |
|---|---|---|
| TikTok follower growth (MoM %) | **25%** | Normalized. >20% MoM = high. Requires historical data (start polling now). |
| TikTok engagement rate | **15%** | Avg engagement across recent videos. >3% = healthy. |
| Instagram follower growth (MoM %) | **15%** | Secondary social signal. Requires historical polling. |
| Amazon BSR rank + review velocity | **20%** | Review-count growth WoW is proxy for sales momentum. 'X bought' badge = bonus. |
| Google Trends search volume growth | **10%** | Search trending upward = mainstream awareness building. |
| Reddit mention velocity | **10%** | Early signal. Organic buzz precedes mainstream. New mentions this week vs. 4-wk avg. |
| NOT IN retail scan data (Nielsen/IRI) | **Bonus +** | High social momentum but NOT yet in retail = prime target. |
| Sentiment score (AI) | **5%** | Positive community sentiment adds signal. Very negative = flag / deprioritize. |

### 5.3 Report Format & Delivery
- Delivery: Email (initially). Explore Slack integration later.
- Personalization: each salesperson gets only their assigned categories
- Sections: *Top 5 Brands to Watch This Week* | *Brands on Your Radar (full ranked list)* | *Trending Hashtags in Your Categories* | *Notable Signals*
- Each entry: Momentum Score, follower counts, WoW change, Amazon signals, 1-line AI summary, recommended action (Call Now / Watch / Skip)
- Schedule: Run weekly data collection Saturday night, send report Monday 7am

## 6. Module 3: Monthly Category Deep Dive — Spec

The most sophisticated module. Combines all data sources into a category landscape report formatted for Target buyer meetings.

### 6.1 Input
- Nielsen/IRI/Circana monthly export file (CSV or Excel upload)
- Category selection (which categories to include)
- Optional date range override

### 6.2 Nielsen/IRI File Ingestion

Build a flexible ingestion layer that handles variable column formats. Key fields:
- Brand name (normalize casing, handle variations)
- Category code + category name
- Sales $ and units for 1, 3, 6, 12-month periods
- YoY growth %

Once ingested, system maps Nielsen brand names → TikTok/Instagram handles + Amazon brand pages using the handle resolution logic from Module 1.

### 6.3 The Quadrant Analysis — Core Value

> **The 2x2 That Matters**
>
> - **HIGH Social Momentum + LOW Retail Velocity** = **CALL NOW** (up-and-coming DTC, not yet at retail)
> - **HIGH Social Momentum + HIGH Retail Velocity** = Established player (probably already represented)
> - **LOW Social Momentum + HIGH Retail Velocity** = Incumbent (declining or boring brand)
> - **LOW Social Momentum + LOW Retail Velocity** = Skip
>
> The top-left quadrant is Barcode's alpha. High social, low retail = call before anyone else does.

### 6.4 Report Sections
- Category Overview: size, growth rate, key trends
- Brand Landscape Map: full ranked list of brands by momentum score with retail and social data side by side
- Quadrant Plot: visual 2x2 placing all known brands
- Top Opportunities: AI-generated narrative on the top 3–5 brands to prioritize
- Trend Signals: trending hashtags, Google search themes, Exploding Topics for the category
- Not Yet in Retail: brands in social/Amazon but absent from Nielsen data — the sleepers

## 7. Technical Architecture

See [`docs/00-architecture.md`](./00-architecture.md) for the as-built reference. Key choices made during scaffolding:

- **Node/TypeScript** instead of Python — keeps one language across stack, matches the team's existing Adam/Juan agent template
- **Supabase (Postgres)** instead of Firebase — better fit for time-series aggregations and quadrant joins
- **Playwright (Node)** for scraping — same engine as Python Playwright, swapped library only
- **Vercel Cron** instead of standalone cron — no separate scheduler infra to maintain
- **Anthropic Claude SDK** with the Adam-style 25-iteration agentic loop powering the in-app chat (Barry)

### 7.1 Key Design Decisions (from original PRD)
- **Start polling NOW** — you cannot buy historical Instagram/TikTok growth data. The sooner you start, the richer your trend lines.
- **Handle resolution is the linchpin** — invest in making brand name → social handle mapping robust. This is the glue that connects all data sources.
- **Scraping resilience** — Amazon and TikTok will occasionally block. Build retry logic, rotating user agents, consider residential proxy rotation if blocking becomes a real problem.
- **Start narrow** — seed the system with Barcode's known brands and 3–5 categories. Don't try to scrape all of Amazon on day one.
- **Modular data fetchers** — each data source is its own module so they can fail independently.

## 8. Build Phases & Prioritization

| # | Phase | Deliverable | Timeline |
|---|---|---|---|
| **0** | **Foundation** | Repo + DB schema + env + Supabase clients + types. No UI yet — just capturing data. | Week 1 |
| **1** | **Brand Card MVP** | Brand lookup: enter name → TikTok + IG count, Amazon rating, Google Trends line. Handle resolution working. No sentiment yet. JSON + basic HTML display. | Week 2–3 |
| **2** | **Sentiment Layer** | Claude API integrated. Pull TikTok + Reddit comments. Structured sentiment output. Add to Brand Card. | Week 3–4 |
| **3** | **Discovery Engine v1** | TikTok hashtag crawler + Amazon category top 100 scrape. Feeds new brands into DB. Momentum Score. Basic ranking. | Week 4–6 |
| **4** | **Weekly Report v1** | Automated email report per salesperson. Top brands by Momentum Score. Send Monday morning. Get Barcode's feedback. | Week 6–7 |
| **5** | **Nielsen Ingestion** | File upload UI + CSV/Excel parser. Map brands to social handles. Cross-reference with Discovery Engine. Quadrant analysis. | Week 7–9 |
| **6** | **Monthly Deep Dive v1** | Full category report: landscape, quadrant, AI narrative, opportunity list. PDF or formatted email. | Week 9–12 |
| **7** | **Expansion** | Reddit, Shopify, Exploding Topics, Grok/X, TikTok Shop, SmartScout (if Barcode upgrades). Ongoing. | Month 3+ |
| **A** | **Agent layer (Barry)** | In-app chat that calls the same fetchers/DB as everything else. Can layer in after Phase 1. | Anytime |

## 9. Inputs Needed Before / During Build

### 9.1 From Barcode — Before You Start
- Student codebase — review for any salvageable components. Expect to start mostly fresh.
- Sample Nielsen/IRI monthly export — need real column headers before building ingestion
- Sample SmartScout export
- Sample Exploding Topics export
- List of 10–20 brands they currently monitor or are actively pursuing
- List of their 3–5 primary product categories
- Their current plan tiers for SmartScout and Exploding Topics
- Preferred weekly report delivery format: email vs. Slack vs. other

### 9.2 External — API Registrations
- TikTok Developer App *(submitted, 1–2 wk approval)*
- TikTok Commercial Content API *(submitted, 2 day approval)*
- Meta Developer App + Instagram Business Discovery API approval
- Reddit API app registration
- Anthropic API key
- SmartScout API key *(if Barcode upgrades to Enterprise)*
- Exploding Topics API key *(if Barcode is on Business plan)*

## 10. Scope Definition

| IN SCOPE | OUT OF SCOPE (for now) |
|---|---|
| Brand Card (on-demand lookup) | Client-facing portal or white-label product |
| Weekly automated scouting report by email | Pinterest or YouTube data |
| Monthly category deep dive with Nielsen upload | LinkedIn signals |
| TikTok + Instagram + Amazon + Google Trends + Reddit signals | X/Twitter (paywalled API) |
| AI sentiment analysis on comments | CRM integration |
| Momentum Score + quadrant analysis | User authentication / multi-tenant |
| Internal use by Barcode sales team | Mobile app |

## 11. Engagement Model & Pricing

- **Structure**: Monthly retainer (not a one-time build fee)
- **Rate**: $1,000/month
- **First month**: Free — starts when the tool is live and Barcode is actively using it
- **Covers**: tool hosting, API costs, maintenance, ongoing development, weekly report runs
- **Review at 6 months**: revisit pricing once you can demonstrate specific brand discoveries that led to new client relationships
- **Strategic goal**: this is the wedge. The tool creates a live connection into Barcode's business and opens doors to broader GenAI consulting work.

*— End of PRD —*
