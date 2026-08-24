# "The Index of Babel"

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
3. CLIP analysis: Embeddings for the image set can be calculated on my own machine and uploaded. Constructing the corresponding search text embeddings and comparing them with the image embeddings is surprisingly cheap, enough that it can be done in-browser.
4. Image creation and curation: Outside the scope of this repo. I already have a versatile set of Stable Diffusion scripts that can do this sort of thing.

## Design extensions
Significant user-visible features I decided to add during implementation will be documented here.

### 8/12/26: Base tile construction

The default room/tile shape ought to be based on sensible, concrete geometry, rather than being pure AI. I'll build it in Blender, and use a render as a base for Stable Diffusion img2img.

### 8/14/26: Image stories and metadata

Images are more interesting when paired with stories. AI can generate stories extremely cheaply, and the quality can be pretty decent if you keep them short. For each tile, also generate a story. Curate stories to make sure they're reasonably interesting and correct. For any unique tile, users should be able to view the story, along with the style keywords used to generate the image. Search should factor in tag and story content along with image analysis.

### 8/15/26: Image search certainty

Mixing the unique rooms with boring default ones provides an interesting way to make search certainty more visible: have the ratio of unique to default rooms vary based on that certainty. If a search is for something that can be strongly matched (e.g. "red"), there shouldn't be any default rooms near the top matches at all. If the search is for something that isn't a strong match (e.g. "asgj;"), even the highest-ranked matches should remain evenly mixed with default rooms. Varying default room ratio based on certainty across the whole search body turns certainty into a visible gradient.

### 8/16/26: Sliding tile room reordering, base tile variants

To make the reordering on search feel more like a real space change, animate the rooms moving like a sliding tile puzzle. We can't really solve it like a puzzle: if there's 1000 tiles, a reasonable solution would usually require tens of thousands of moves. Instead, fake it by only allowing tiles to be swapped when they're outside of the visible area, finding a way to remap them that involves a handful of vertical and horizontal slides that can run in a 1-2 second animation.

Using the exact same default tile for every non-unique square makes them seem especially fake. A small number of variations, randomly chosen, would be a better idea. They'll all look nearly identical, but have minor variations to the books.


### 8/18/26: Remove "Library of Babel" constraints from the center tile.
If we're making the books into UI elements, five shelves of 32 books each makes the books way too small to have readable text at any reasonable zoom level. Play into the uniqueness of the center room, and give it fewer shelves with larger books. This will also let me build the center into a more unique art piece.

### 8/20/26: Accessibility support
The application should be fully usable in a screen reader, and reduced motion constraints should be honored. Keyboard controls should let users navigate the library, and UI elements should be mirrored in the DOM if possible, rather than just being built in a canvas. Map structure changes and returning to the center should be announced by screen readers. I'll fully test this with the orca screen reader before release.

### 8/22/26: Catalog mode
This project is all about being able to use technology and information science to enhance our ability to search random noise for accidental meaning. To serve that purpose, there should be an alternate interface that maximizes search capability by sacrificing the illusion of the infinite library.

In catalog mode, no default rooms will be shown, and rooms will be shown as a flat list in order of search match. Keywords and stories will appear to the right of each room, not needing to be opened automatically. When searching, rank and certainty metrics will be plainly shown for each room. The map view's mostly-diegetic interface will be replaced with a search UI modeled after the usual conventions for searching and sorting an online dataset.
