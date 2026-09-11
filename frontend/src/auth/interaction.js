import { InteractionStatus } from '@azure/msal-browser';

/**
 * Is MSAL still deciding whether somebody is signed in?
 *
 * Its own answer to "are you authenticated" is false until the redirect hash
 * has been read, and false is indistinguishable from a real signed-out state.
 * So the question has three answers, not two, and this names the third.
 *
 * Lives in its own module rather than beside the component because the bug it
 * guards against is a missing entry in a list, which is not something that can
 * be seen by rendering -- it is only visible for the few hundred milliseconds
 * before MSAL finishes, and only sometimes.
 */
export function isResolvingSignIn(inProgress) {
  return (
    // First state MSAL reports, before the redirect hash is read. Omitting it
    // rendered the signed-out page to somebody who had just signed in.
    inProgress === InteractionStatus.Startup ||
    inProgress === InteractionStatus.HandleRedirect ||
    inProgress === InteractionStatus.Login
  );
}
