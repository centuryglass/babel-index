# "The Indexing of Babel"

1. Create an image of one room in the Library of Babel. Make it detailed yet generic - a photorealistic model would probably be appropriate. Make sure it tiles seamlessly.
2. Using Stable Diffusion, dynamic prompting and ControlNet, create thousands of variant rooms, each expressing a unique randomized combination of concepts and visual styles as a library room, each still capable of tiling with any other set of rooms.
3. Tag, filter, and curate: rate rooms by visual interest, and tag ones I find especially intriguing. Delete any that are offensive, horrible, or boring to an unacceptable degree.
4. Create the display program: a web application that arranges the rooms in a random order, and allows the user to pan and zoom. A certain percentage (maybe 80% by default?) will be identical copies of the original generic room. The user will encounter increasing resistance as they pan towards the edge of the total content space, preventing them from leaving the area where the finite non-generic rooms can be found.
5. At the center of the library, integrate a text box and a submit button into one of the room images. If the user enters a search term and clicks enter, CLIP (or some equivalent) will rank all the non-duplicate rooms by that term. When finished, the rooms on the map will be re-ordered so that the ones that most closely match that term will be closest to the center.
6. For fun, maybe add a few extra controls hidden in the image in that center room:
  - Dynamically add previous search terms to the spines of books, click them to restore the previous order.
  - Add a button somewhere to apply new random orders to the books. 
  - Hidden controls to allow sorting by the manual scores and tags I assigned to the image. 
  - An alternate submit button that instead of sorting, invokes Stable Diffusion to generate new rooms based on the search term.

## Origin:
I conceived of this project in late 2024, but never started because it seemed like more of a time sink than I was prepared to commit to at the time. Agentic programming has put it back within reach. I will be delegating most programming tasks to Claude Opus 5.

## Tech stack thoughts
1. Web: Node.js+Express+React. Not the most efficient option, perhaps, but it's a stack I have professional experience with and would like to revisit.
2. Cloud: GCP+Terraform have proven cheap and versatile, but it's worth considering other options.
3. CLIP backend: Explore external APIs. A microservice wrapping CLIP in a simple API is easy enough, but it might be cheaper to just outsource.
4. Image creation, tagging, and ranking: Outside the scope of this repo. I already have a versatile set of Stable Diffusion scripts that can do this sort of thing.
