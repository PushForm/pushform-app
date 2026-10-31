# AI Chat

## Ask a question

Open **AI Chat** in the left menu bar of an editor. On Home, use its chat button. Ask what you want to do, such as “How do I draw an eight-sided polygon in Layout?”

You can ask for help, report a problem, or request a feature. For a problem, describe what you did and what happened. Before filing a ticket, the chat shows a brief for you to check and asks you to confirm.

## Ask to see a control

When you ask how to perform a task, the agent can highlight the next useful control without a separate request. You can also ask “Show me the Polygon button.” When on-screen guidance is available, the agent reveals the control and highlights it with a pulsing glow for five seconds. With reduced motion enabled, the emphasis stays steady.

The chat can notice if you activate that target within thirty seconds of the highlight starting, then continue the instructions. Clicking confirms that you interacted with the control; it does not confirm that you completed the whole task.

After you choose a tool, the agent continues with how to use it. It looks up missing steps before asking you for more details. If the help still lacks a step, it says which detail is unknown and asks a question only when your answer affects what to do next.

Highlighting does not click a tool, select an object, or edit the document for you. Opening a panel can reveal an item in the Object browser. Instructions stay in chat while you follow the step. Guidance does not show toasts or floating messages, and looking up a control does not close chat. A fading highlight does not require you to click or trigger a reminder.

## Ask for a change to your document

AI Chat can change the document open in the tab you send from: a Layout document, or a 3D model. Ask for the change in plain words, such as “Put the three shelves in one group, then make two more copies of it 40 cm higher” or “Paint the top of the table oak.” A question gets an answer only; the agent changes the document only when you ask it to.

Each change applies all at once, without a confirmation step. The chat then shows a line such as “Changed the document: Group the shelves. Undo reverts it.” One request is one undo step, so **Undo** reverts the whole change. If any part of a change fails, nothing changes and the agent says what could not be done.

## Ask for a change to a 3D model

In a 3D model the agent can:

- make groups and components, explode them, and make a component unique;
- place more copies of a component;
- move, rotate and scale, including copies in a row or around an axis;
- rename, hide, show, lock, unlock and delete;
- create tags, assign them, and change a tag’s visibility and color;
- create plain-color materials and paint faces, solids, groups and components.

It cannot draw new geometry, push or pull faces, or combine solids yet. It says so when you ask for one of these.

## How the agent edits a 3D model

The agent edits the group or component you have open, or the whole model when none is open. Editing a component changes every copy of it, and the agent says how many copies that is. It uses the model’s units when it talks to you. The agent cannot see the model, so it reads what is there and asks when your request could mean more than one thing, such as “the left wall” when two walls face the same way.

A change applies only while its tab is still open and active. If you switch tabs or close the document first, nothing changes. While a change is being applied, the chat shows **Applying the change…**, and you cannot make other edits until it finishes. Stopping the reply cancels the change.

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
