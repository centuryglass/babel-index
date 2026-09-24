# "The Index of Babel"

This is the original design, and it is not kept in sync with the code. [`architecture.md`](architecture.md) describes the system as built. This document is a record of human choices, and will always be human-written. AI additions to this page are limited to making minor typo and error corrections and adding obvious placeholder entries that I will fill in myself.

1. Create an image of one room in the Library of Babel. Make it detailed yet generic - a photorealistic model would probably be appropriate. Make sure it tiles seamlessly.
2. Using Stable Diffusion, dynamic prompting and ControlNet, create thousands of variant rooms, each expressing a unique randomized combination of concepts and visual styles as a library room, each still capable of tiling with any other set of rooms.
3. Curate: go through results, save rooms that are unique, interesting, or exceptional.
4. Create the display program: a web application that arranges the rooms in a random order, and allows the user to pan and zoom. A configurable percentage will be identical copies of the original generic room. The user will encounter increasing resistance as they pan towards the edge of the total content space, preventing them from leaving the area where the finite non-generic rooms can be found.
5. At the center of the library, integrate a text box into one of the room images. If the user enters a search term and clicks enter, CLIP will rank all the non-duplicate rooms by that term. When finished, the rooms on the map will be re-ordered so that the ones that most closely match that term will be closest to the center.
6. For fun, maybe add a few extra controls hidden in the image in that center room:
  - Dynamically add previous search terms to the spines of books, click them to restore the previous order.
  - Add a button somewhere to apply new random orders to the books. 
  - Hidden controls to allow sorting by the manual scores and tags I assigned to the image. 

## Origin:
I conceived of this project in late 2024, but never started because it seemed like more of a time sink than I was prepared to commit to at the time. Agentic programming has put it back within reach. I will be delegating most programming tasks to Claude Opus 5.

## Tech stack thoughts
1. Web: Node.js+Express+React. Not the most efficient option, perhaps, but it's a stack I have professional experience with and would like to revisit.
2. Cloud: GCP+Terraform have proven cheap and versatile, but it's worth considering other options. I'll likely just run the server on my VPS to minimize extra costs. Image hosting should be on Cloudflare R2, which is cheap enough to be effectively free.
3. CLIP analysis: embeddings for the image set can be calculated on my own machine and uploaded. Constructing the corresponding search text embeddings and comparing them with the image embeddings is surprisingly cheap, enough that it can be done in-browser.
4. Image creation and curation: Outside the scope of this repo. I already have a versatile set of Stable Diffusion scripts that can do this sort of thing.

## Design extensions
Significant user-visible features I decided to add during implementation will be documented here.

### 8/11/2026: Tile scope change: stick with one bookshelf
Rooms from the Library of Babel as described don't tile well in 2D, and including the full room makes it harder to include smaller details. Instead of a full room, each tile will be a single wall holding one shelf.

### 8/12/26: Base tile construction

The default room/tile shape ought to be based on sensible, concrete geometry, rather than being pure AI. I'll build it in Blender, and use a render as a base for Stable Diffusion img2img.

### 8/14/26: Image stories and metadata

Images are more interesting when paired with stories. AI can generate stories extremely cheaply, and the quality can be pretty decent if you keep them short. For each tile, also generate a story. Curate stories to make sure they're reasonably interesting and correct. For any unique tile, users should be able to view the story, along with the style keywords used to generate the image. Search should factor in tag and story content along with image analysis.

### 8/15/26: Image search certainty

Mixing the unique rooms with boring default ones provides an interesting way to make search certainty more visible: have the ratio of unique to default rooms vary based on that certainty. If a search is for something that can be strongly matched (e.g. "red"), there shouldn't be any default rooms near the top matches at all. If the search is for something that isn't a strong match (e.g. "asgj;"), even the highest-ranked matches should remain evenly mixed with default rooms. Varying default room ratio based on certainty across the whole search body turns certainty into a visible gradient.

### 8/16/26: Sliding tile room reordering, base tile variants

To make the reordering on search feel more like a real space change, animate the rooms moving like a sliding tile puzzle. We can't really solve it like a puzzle: if there's 1000 tiles, a reasonable solution would usually require tens of thousands of moves. Instead, fake it by only allowing tiles to be swapped when they're outside of the visible area, finding a way to remap them that involves a handful of vertical and horizontal slides that can run in a 1-2 second animation.

Using the exact same default tile for every non-unique square makes them seem especially fake. A small number of variations, randomly chosen, would be a better idea. They'll all look nearly identical, but have minor variations to the books.

### 8/18/26: Remove "Library of Babel" constraints from the center tile
If we're making the books into UI elements, five shelves of 32 books each makes the books way too small to have readable text at any reasonable zoom level. Play into the uniqueness of the center room, and give it fewer shelves with larger books. This will also let me build the center into a more unique art piece.

### 8/20/26: Accessibility support
The application should be fully usable in a screen reader, and reduced motion constraints should be honored. Keyboard controls should let users navigate the library, and UI elements should be mirrored in the DOM where possible. Mirroring the entire map with tens of thousands of nodes within the DOM is a bad idea for performance reasons, so we'll use a keyboard cursor and a live region rather than a full mirror.  Map structure changes and returning to the center should be announced by screen readers. I'll fully test this with the orca screen reader before release.

### 8/22/26: Catalog mode
This project is all about being able to use technology and information science to enhance our ability to search random noise for accidental meaning. To serve that purpose, there should be an alternate interface that maximizes search capability by sacrificing the illusion of the infinite library.

In catalog mode, no default rooms will be shown, and rooms will be shown as a flat list in order of search match. Keywords and stories will appear to the right of each room, not needing to be opened automatically. When searching, rank and certainty metrics will be plainly shown for each room. The map view's mostly-diegetic interface will be replaced with a search UI modeled after the usual conventions for searching and sorting an online dataset.

### 8/28/2026: Artist's Statement / "Library of Babel" book
I'll want some sort of title page to tie the whole thing together and explain what this project means. In the center tile, an open "Index of Babel" book will be clickable, opening an overlay. In that overlay, I'll write an in-universe explanation of the project on the left side, and my artist's statement on the right. As a fun Easter egg, a link in the artist's statement should let you load a random book following the "Library of Babel" specifications of 25 characters, eighty characters per line, forty lines per page, four hundred and ten pages per book.

### 8/28/2026: Keyword links
The keywords used to generate rooms are presented completely without explanation. It would be neat to provide reference links for each of them, so a user that sees an unfamiliar artist name on an interesting tile can easily find out who that artist is. A small arrow on the right side of each tag will link to that external page, usually Wikipedia. An LLM given my tag list can provide an initial set of links, and manually validating and correcting that list won't take more than an hour or two.

### 8/28/2026: Room Titles
Rooms are currently listed by index, which is a meaningless number. Naming things is hard, but LLMs are good at it, and even a low-end LLM can come up with a decent name. I'll create a script which forwards each room's image and story to the LLM, and asks for a unique short title, making it retry any time it picks an existing title. Titles will be visible within the catalog, and in the room overlays where the stories are shown. Titles should also be searchable.

### 8/30/26: Favorite count tracking
This project is fundamentally about searching and curation, and I should do something to support that in the code. The solution: add a favorite icon to each room detail panel, and show each room's global favorite count. 

#### The interface
Favorite count should appear in both map and catalog views. Users should be able to both add and remove a room from favorites from either the map or the catalog. Users should be able to sort in two ways: either by their own favorites, or by global favorite count. 

#### Data tracking
I don't want to spy on my users and I don't want to build an account system, but I don't want the counts to just be raw numbers that anyone can mess with by hitting an endpoint either.

Personal favorite lists can be tracked in local storage. The server should never expose favorites on a per-user basis; let users track their own favorites. 

Global counts will be tracked internally as per-image sets of hashed IP addresses, salted per-room. The hashing isn't a real security method, it's mostly just present as another way to signal that I'm not interested in spying on my users. Checking favorites on a room returns the size of the set, add_favorite and remove_favorite endpoints add and remove the request IP from the set. Gaming the system in a limited way is possible, but not something I'm very worried about. The important part is ensuring a bad actor can't just zero out favorite counts or boost them infinitely.

### 9/2/26: Allow users to get rid of generic rooms on the map
The generic rooms are useful for search density signalling and for making map browsing feel more like exploration. On the other hand, they do make viewing all rooms on the map slightly slower, and that's contrary to this project's intent to enhance discoverability. Adding a "distill" mode (renamed from "sieve mode" 9/5) that lets us disable or enable generic rooms solves the problem.

When distill mode is active, generic rooms will fade to black, and use the existing sliding tile animation to shuffle off-screen. Distill mode will be toggled with another control integrated into the center map tile, a lever in the lower right. Distance from the rest of the controls and a very slightly menacing gauge indicator will serve to subtly indicate that this feature is not the expected normal mode of navigation.

### 9/5/26: Favorite tracking adjustments
IP is not a very useful way for tracking favorites, as IP addresses change often. Browsers can instead use a random token generated once and held in local storage, so that the local favorite store and the global counts stay in sync after network changes. This makes falsely running up favorite counts very slightly easier for a dedicated attacker, but still hard enough to not be a likely threat. IP rate-limiting should be enough to prevent serious issues, if someone actually does decide to mess with my code.

### 9/11/26: Leather-and-paper visual theme
The current styling in UI elements is a sort of generic web interface dark mode, an AI-chosen placeholder I've always intended to replace. It will be swapped with a dark leather and antique paper look, with text sitting on cream-colored pages over a dark background with a faint leather texture. Most UI elements like buttons and toolbars will be left as white text on a black background. Trying to apply skeuomorphic design to those elements just draws attention to how they're very obviously web interface elements, not physical objects. We'll keep them clearly visible yet subtle. 

### 9/11/26: Server-side rendering and link previews
The current site is effectively invisible to search engines, web crawlers, and anyone who keeps JavaScript disabled. When JavaScript isn't enabled, we should instead provide a version of the catalog mode with links to pure HTML versions of each room overlay.

### 9/13/26: Shareable links and additional server-side rendering
Links to specific rooms should also be easily accessible via a share button, and opening them on a browser with JavaScript enabled should send you to the appropriate overlay within the catalog or map. Help and artist's statement pages should also have static links and server-side versions.

### 9/22/26: Search logic: replace "certainty" with "match strength"
In my original design, search results are ranked based on combined signals, then distributed according to both rank and certainty. The problem is that certainty and rank are not necessarily related. A search result can be ranked very highly with low certainty, or ranked very low with high certainty.

The real value to measure is *match strength*, a way of scoring results along a fixed scale that provides more information than rank, but never conflicts with it. That will let us arrange rooms on the map in a way that makes both the relative order of rooms and the number of strong matches clear.

I'll also be removing the concept of "negative certainty" used with CLIP results. A CLIP angle comparison that scores even lower than a check against random noise doesn't necessarily let us assume it's some sort of anti-match. It's more correct to just treat it as a total non-match.

## Engineering changes

### 8/12/26: Serve lower-resolution versions of room images when zoomed out further
Each room tile is a relatively large image file. Loading one or two at a time is near instant, but at high zoom levels we can fit hundreds on-screen at once, and we're still loading the whole image despite only showing a fraction of the pixels.

The standard solution is to construct a resolution pyramid: keep a copy of each image at half-resolution, quarter-resolution, etc. and only send users the smallest one that doesn't need to be scaled up. As the user zooms in and out, the site should smoothly transition between different levels as appropriate. A simple script can handle the process of creating the smaller versions of each image.

### 8/13/26: Handle CLIP text embedding server-side, every other part of search client-side
To search image content, we need to generate CLIP text embedding vectors for search queries. This is cheap enough to be done in either the browser or server, but it requires downloading a large CLIP model. To avoid forcing every user to download a 90MB text model, we'll just download it once server-side, and provide an endpoint that accepts search queries and returns embedding vectors.

Because the data set is only a few thousand static tiles, every other part of search can be done client-side. Handling individual searches is not much of a burden, but handling many could cause significant lag on my low-end production VPS. Client-side code will handle the process of comparing text against room stories and keywords, and comparing the server-provided text embedding vectors with the pre-generated image vectors.

### 8/22/26: Make CLIP an optional dependency
CLIP is a fairly heavy dependency, and is only available for a few platforms. If I want to quickly test the server on my Android phone through Termux, it fails because no version of our CLIP dependency is available for Android. Only some testing requires CLIP, and mobile testing is occasionally a useful option.

Instead of requiring CLIP, we'll make it optional. The code will attempt to use it, but if not available it will simply log a warning and continue without it. When CLIP is absent, tiles will not be scored on image content, and search will be based entirely on associated text data.

### 8/27/26: Split `main.jsx` apart, moving functionality into React hooks where possible.
Logic related to rendering and React behavior has been accumulating in `main.jsx`, which is already over 1,500 lines long. This is a classic anti-pattern, worth interrupting before it gets any worse. The map cursor, center shelf behavior, mode transitions, dataset management, tile rearrangement, and search handling can all be extracted into single-purpose React hook modules.

### 8/27/26: Migrate from JavaScript to TypeScript
The project started as pure React/JavaScript because that's what I'm most familiar with. Despite that, I prefer my code to be strongly typed, and think it's worth the effort to transition this project even though it's a significant change. With parallel AI development, the project can be split into sensible related sections and migrated in chunks using AI agents in just a few days. We'll use esbuild to compile the project at launch, avoiding the need to keep a dist directory in sync.

### 8/28/26: Pack coarse-level resolution pyramid images into tile-sheets to reduce potential costs
Cloudflare R2 hosting charges mostly by number of files served. Serving thousands of tiny tile images accumulates cost at thousands of times the rate of serving a single combined image. Breaking those image sheets apart client-side adds a small amount of increased client-side processing required, but this design ensures that a single user casually scrolling while zoomed out doesn't end up using a significant portion of my image hosting budget.

### 8/28/26: Formalize search rules and calibrate against the real corpus.
Search is poorly calibrated, and the interaction between image, story, and tag search rules is not stable or well-documented.

To solve the first problem, we'll calibrate against my existing dataset, which has over a thousand images already. We'll test those image embeddings against text embeddings for each style tag used within the project, and against strings of nonsense characters that shouldn't strongly match any image. That should give us a strong picture of how text/image vector cosine comparisons usually scale across different comparisons, so we know what range is actually meaningful.

For the second, I'll create a single `docs/search_rules.md` file, where search rules will be defined around simple expected behaviors. This document will serve as the source of truth, and tests and code will be required to comply with the specification it defines. 

### 8/30/26: Move the Python tools used for image processing, story generation, and other dataset management into tools/curation
Evaluating generated images, creating stories for those images, and evaluating whether they require content tags or additional inpainting work is handled through a PySide6 GUI and a handful of scripts that integrate with local, Anthropic, and/or OpenRouter APIs. Those were roughly adapted from scripts I wrote a while ago for other tasks, and weren't included because they don't interact with the client/server code.  With some minor code cleanup, there's no reason not to include those scripts as well under tools/curation. They'll be treated as largely independent of the rest of the project.

### 9/10/26: Switch primary canvas map renderer to WebGL, keeping Canvas2D as a fallback
As the dataset has grown to its final size of 2048 tiles, performance has become increasingly poor on mobile devices, and occasionally subpar on desktops as well. A number of smaller improvements were considered and some were even implemented, but to significantly improve performance we'll need to make full use of GPU processing. A spike on 9/9 confirmed that switching to a WebGL renderer results in a roughly 15x speed boost on image processing for the tile rearrangement. The old Canvas2D renderer will be preserved as a fallback for systems that don't support WebGL.

### 9/14/26: Implement automated validated deployment
Initial plans were to deploy the site on GCP using Terraform, which would make continuous deployment trivial. That plan was abandoned for reasons of cost. I already pay five dollars a month for a cheap Debian VPS, and that VPS has more than enough capability remaining to also serve this site. Manually deploying over ssh only took a couple minutes, so full continuous deployment was ignored.

Fully automated deployment is best practice though, and securely implementing it is easy enough to be worth the effort. A scoped SSH key, a simple deployment script, an added health check endpoint, and a new GitHub action triggered by pushing to main will let us ensure releases are reliably triggered and always validated.

### 9/16/26: Build and apply a workflow for fixing issues with AI-generated code comments
AI development has been primarily using Claude Opus 5.0 and Claude Sonnet 5.0. Both models produce competent work when properly directed, but they struggle to clearly describe that work. Code comments are often overwrought, tangled prose that needs more manual correction than I'm able to provide. For example, consider this line from AGENTS.md:

> Adding twice is one favorite and removing what was never there is nothing, so no endpoint can zero a room out or run it up.

That's how Claude Opus 5.0 chose to say that repeated attempts to add or remove a favorite won't change the total count. Simpler models can easily correct that sort of problem, and can do so cheaply in parallel. I tested a variety of low-cost models, and identified Qwen 3.8 Flash as the best option for correcting these sorts of issues without introducing errors. With a well-organized plan, a script that ensures changes are applied to comments only, and with agents working in parallel through OpenCode, the entire project's comments and documentation could be audited and improved within a day. Tools for repeating the process remain on the qwen3.8-flash-comment-fix branch, and instructions for accessing those tools and auditing comments in specific areas have been added to AGENTS.md for future use.

### 9/17/26: Improve this project's position as a software engineering portfolio piece
This project serves as both an art piece and as proof I can follow competent engineering practices when using agentic AI for software development. Up to this point, I've held off on a few important steps that are necessary for the second purpose, all of which I can correct easily.

- The project should integrate proper release management into CI/CD, instead of leaving version pinned at 0.0.0. I'll add release-please for versioning, and deploy changes only on release.
- Automated dependency scanning and code quality checks are missing. Adding CodeQL scanning and Dependabot alerts should be enough of a correction.
- Documentation is targeted towards users, AI agents, and myself, and not towards engineer evaluation. Adjusting the README project framing and adding architecture and API docs should be enough of a solution.

### 9/19/26: Add a secure log viewing page, including hourly usage metrics that respect visitor privacy
Logging is managed through pino, and logs are just saved through systemd. Actually checking those logs involves logging into the server via ssh and using `journalctl`. A full logging service would be overkill, but a simple admin page secured with basic auth would let me easily view logs from any browser. In addition, I'll be adding some basic usage metrics to the logging, enough to track activity but not enough to spy on any user. Hourly unique viewers, searches, and added/removed favorites will be tracked in memory and reported as counts within the logs.

### 9/21/26: Stop tracking tasks through in-repo files, and use GitHub issues instead
Tasks were previously tracked in docs/pending_task_list.md, a habit I picked up from previous solo project work. A flat file was the most convenient approach when I was completely on my own, but even then it made it hard to track closed issues and abandoned project directions. Now that work is coordinated across AI agents, and all changes to main require a PR, GitHub issues make it much easier to track tasks, ensure they're closed on completion, and enable casual comments and additions.

The downside is that GitHub issues are slightly more inconvenient for agents, as they need to load them via individual MCP commands. To solve this, we'll set up a script that automatically pulls the full set of issues into a temporary set of cache files and injects the titles into context on session start.

### 9/22/26: Begin refactoring site code to allow arbitrary themed datasets
Most of the art project aspects of this site are defined and loaded externally. Only a small handful of fixed resources are used by the project, and none of them are deeply entangled in the code. If we migrated all of them to the external corpus, the library theme would become completely optional. An alternate dataset could have tiles that are city blocks, or apartment windows, or really anything that works well as a set of tiles that change arrangement. The site could even serve multiple datasets under a single URL.

Only one corpus currently exists, and creating another would require a significant time commitment. This refactor will proceed slowly, with the bulk of the work deferred until I decide to create another corpus.
