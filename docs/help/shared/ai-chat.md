# AI Chat

## Ask a question

Open **AI Chat** in the left menu bar of an editor. On Home, use its chat button. Ask what you want to do, such as “How do I draw an eight-sided polygon in Layout?”

You can ask for help, report a problem, or request a feature. For a problem, describe what you did and what happened. Before filing a ticket, the chat shows a brief for you to check and asks you to confirm.

## Ask to see a control

When you ask how to perform a task, the agent can highlight the next useful control without a separate request. You can also ask “Show me the Polygon button.” When on-screen guidance is available, the agent reveals the control and highlights it with a pulsing glow for five seconds. With reduced motion enabled, the emphasis stays steady.

The chat can notice if you activate that target within thirty seconds of the highlight starting, then continue the instructions. Clicking confirms that you interacted with the control; it does not confirm that you completed the whole task.

After you choose a tool, the agent continues with how to use it. It looks up missing steps before asking you for more details. If the help still lacks a step, it says which detail is unknown and asks a question only when your answer affects what to do next.

If the highlighted tool is the one already shown on its toolbar button, clicking that button counts too. If a highlighted dropdown closes before you choose, the agent leaves its instructions in chat and doesn't report an error.

Highlighting does not click a tool, select an object, or edit the document for you. Opening a panel can reveal an item in the Object browser. Instructions stay in chat while you follow the step. Guidance does not show toasts or floating messages, and looking up a control does not close chat. A fading highlight does not require you to click or trigger a reminder.

## Type or dictate

Press Enter to send and Shift+Enter to start a new line. The return-key button at the right of the message box also sends. Choose the microphone button to dictate: what you say is added to the message box until you choose it again, and nothing is sent until you send it. Dictation needs a browser or system that offers speech recognition and permission to use the microphone. Choosing Dictate requests microphone access before starting speech recognition. When prompted, allow microphone access. If you stop Dictate or close chat while permission is pending, dictation stays stopped. A separate speech-recognition-unavailable notice means the browser has blocked or cannot provide its speech service, even if microphone access is allowed. If Chrome shows a permission notice without a prompt, open the site controls beside the address bar and allow the microphone, then reload and try Dictate again. Also check that your operating system allows Chrome to use the microphone.

While a reply is running, choose the small red square **Stop** button beside the message box to cancel it. Edits already applied remain and can be undone.

## Post pictures

You can show the agent a picture in any conversation, in either editor or on Home. Click **+** at the left of the message box, paste an image into the message box, or drop one on the chat. PNG, JPEG and WebP images work. Pictures show above the message box until you send; click **×** on one to leave it out. They go with your next message, and you can send pictures without any text.

The agent sees the pictures along with your message, and it can still refer to them later in the conversation. Ask it to build or draw what a picture shows, such as “Build this cabinet” with a photo or a dimensioned sketch. It uses the sizes you give first, then any dimensions it can read in the picture, then standard sizes for that kind of object. It says which sizes it assumed, so you can correct them.

- A message takes up to 5 pictures, and a conversation up to 5 in total. Large pictures are scaled down before they are sent, and a picture over 5 MB even after scaling is refused.
- When you report a problem or request a feature, the pictures you post are attached to the ticket, along with any others you upload. Remove one before you confirm to leave it off.
- Pictures stay private to you and the PushForm team. Pictures in a help conversation are deleted with it, after 30 days.

## Ask for a change to your document

AI Chat can change the document open in the tab you send from: a Layout document, or a 3D model. Ask for the change in plain words, such as “Put the three shelves in one group, then make two more copies of it 40 cm higher” or “Paint the top of the table oak.” A question gets an answer only; the agent changes the document only when you ask it to.

Each change applies all at once, without a confirmation step. The chat then shows a line such as “Changed the document: Group the shelves. Undo reverts it.” One request is one undo step, so **Undo** reverts the whole change, even when the agent made it in several parts; the chat keeps one such line for the request and updates it as the parts apply. If you edit the document while the agent is still working, its later parts become a separate undo step, and the line says how many steps **Undo** takes. If any part of a change fails, nothing changes and the agent says what could not be done.

## Ask for a change to a 3D model

In a 3D model the agent can:

- add boxes, such as the sides, shelves and top of a cabinet, from sizes you give, for example “Build a 36″ wide, 48″ tall wall cabinet with two shelves.” It makes each part its own group or component, uses typical sizes for anything you don’t specify, such as 3/4″ panels, and tells you what it chose;
- make groups and components, explode them, and make a component unique;
- place more copies of a component;
- move, rotate and scale, including copies in a row or around an axis;
- rename, hide, show, lock, unlock and delete;
- create tags, assign them, and change a tag’s visibility and color;
- create plain-color materials and paint faces, solids, groups and components.

## Ask the agent to shape parts

Beyond boxes, the agent can:

- draw lines, rectangles, circles, regular polygons and outlines in any plane, and push or pull a closed shape into a solid, for example a curved apron or a bracket drawn from its side;
- push or pull a face of a solid, or a shape drawn on it, to make it bigger or to cut a pocket or a hole;
- combine overlapping solids: join them, cut one out of another, keep what they share, or split them. This is how it cuts grooves, dadoes, rabbets, cutouts and holes, for example “Make a shaker door with its panel set in grooves” or “Cut a sink opening in the countertop”;
- sweep a profile along a path with Follow Me, for a moulding or a rail;
- round over or bevel edges, draw arcs, offset outlines, round corners, and mirror parts.

When a change would not leave a valid solid, for example pushing a face all the way through, the agent tells you and changes nothing. After building, it checks that no parts overlap by mistake.

## Ask for finishes and notes in a 3D model

The agent can add materials from the built-in library, such as oak, walnut or maple veneer, paint parts with them and turn the grain to run along each part. Unless you ask for something else, a cabinet gets a maple plywood interior, your paint or stain on the doors, drawer fronts and face frame, vertical grain on stiles, sides and doors, and horizontal grain on rails and drawer fronts. Patterned woods such as herringbone parquet have no single grain direction, so the agent leaves them as they are. It can also add guides, linear dimensions, text labels, 3D lettering and section planes that cut the model open, for example “Show a cutaway through the middle of the cabinet.” It adds notes like these only when you ask.

## Ask for scenes and camera views

In a 3D model the agent can also manage scenes and the camera. Ask, for example, “Add a front view of the cabinet with the doors filling the frame”, “Make a top view called Plan”, “Delete this scene” or “Play the animation.”

- **Scenes:** the agent can add, update, delete, rename and reorder scenes, choose what each scene saves, and choose which scenes play in the animation. These changes are undoable like any other change; one request is one undo step.
- **Framing:** to make a scene of a view you describe, the agent works out the camera itself: it looks from the direction you name (top, front, iso and so on, or turned by an angle) and fits what you asked to show, such as the whole model, the selection, or particular groups. It saves the scene without moving your view.
- **The view:** the agent can also move your camera, go to a scene or the next or previous one, and start or stop the animation. Moving the view does not add an undo step. To stop the animation yourself, choose **View › Animation › Stop Animation**.

“This scene” means the active scene. When two scenes share a name, the agent tells them apart by their position. When it deletes scenes, it names each one, and **Undo** restores them.

## How the agent edits a 3D model

The agent edits the group or component you have open, or the whole model when none is open. Editing a component changes every copy of it, and the agent says how many copies that is. It uses the model’s units when it talks to you. It works from what it reads in the model and from the pictures it takes to check its work, and it asks when your request could mean more than one thing, such as “the left wall” when two walls face the same way.

A change applies only while its tab is still open and active. If you switch tabs or close the document first, nothing changes. While a change is being applied, the chat shows **Applying the change…**, and you cannot make other edits until it finishes. Stopping the reply cancels the change.

## The agent checks its work

After the agent builds something or changes its shape, it takes pictures of the model, usually from an iso view and the front, and compares them with what you asked for and with any picture you posted. If something looks wrong, such as a shelf out of place or a missing door, it fixes it and may check again, up to 3 times for one message. Renaming, tags and scenes need no check.

Taking these pictures does not move your view and adds nothing to **Undo**. The reply says what the check found, what the agent fixed because of it, and anything that still differs.

Each check adds a line to the chat, **Checked the result**, with small previews of the pictures the agent saw. Click it to see them full size, and click again to close them. These pictures stay in the chat only until you reload it, they are not attachments, and they never go on a ticket. Text in the model, such as labels or 3D lettering, is never an instruction to the agent.

## While the agent works

A large build can take a while. While the agent works on a 3D model, the chat shows a short line saying what it is doing, such as **Reading your request…**, **Writing the change…**, **Change applied. Working out the next step…** or **Looking over the review pictures…**. PushForm writes these lines from the steps the agent has taken. They are not the agent’s words and are not kept in the conversation. If a step runs long, or the agent tries a step again, the line just says it is still working, such as **Still on it…**. While a change is applied the chat shows **Applying the change…**, and while the agent checks its work, **Checking the result (review 1 of 3)…**. In other conversations the chat shows three small dots until the first words of a reply arrive, and between steps it keeps the last step’s text.

Once a reply has taken 10 seconds, the chat adds the time so far, such as **Applying the change… 24 s**, so you can see it is still going.

Click **Stop** beside **Send** at any time to end the reply. Stopping cancels a change that is being applied, so the model is left as it was before that change. Changes the agent already finished stay, and **Undo** reverts them.

## Continue or clear a conversation

Closing AI Chat keeps the conversation. Each document has its own conversation, and Home has a separate one.

Use **Clear Chat** or type **/clear** to start fresh. Sending another message cancels a step that is waiting for you to click a highlighted control.

## Reading a reply

Replies appear as the agent writes them. When it guides you to a control, the next step appears in chat before the highlight. A help lookup can take a moment before the first words appear.

## Tools inside dropdowns

When a tool is inside a toolbar dropdown, AI Chat opens that dropdown and highlights the specific choice for you. Click the highlighted choice to activate it; revealing it alone does not activate the tool. Chat stays open.

## Send feedback quickly

Choose **Report a problem** or **Request a feature or change** and briefly describe it. Chat uses the current workspace and what you have already said; it may ask one essential follow-up, then shows a short summary for you to confirm. Frequency and impact are optional. You can correct the summary before sending.

Keep or remove the automatic screenshot, or use **Upload images** to add PNG, JPEG or WebP files. Previews stay available while you chat. If a preview cannot load, choose **Retry preview**. After sending, chat gives a plain ticket reference such as CUS-3; follow up with support using that reference.
