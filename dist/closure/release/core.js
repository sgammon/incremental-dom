/**
 * Copyright 2018 The Incremental DOM Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
goog.module('incrementaldom.src.core');
const assertions = goog.require('incrementaldom.src.assertions');
const contextModule = goog.require('incrementaldom.src.context');
const domUtilModule = goog.require('incrementaldom.src.dom_util');
const globalModule = goog.require('incrementaldom.src.global');
const nodeDataModule = goog.require('incrementaldom.src.node_data');
const nodesModule = goog.require('incrementaldom.src.nodes');

/**
 * The default match function to use, if one was not specified when creating
 * the patcher.
 * @param matchNode The node to match against, unused.
 * @param nameOrCtor The name or constructor as declared.
 * @param expectedNameOrCtor The name or constructor of the existing node.
 * @param key The key as declared.
 * @param expectedKey The key of the existing node.
 * @returns True if the node matches, false otherwise.
 */
function defaultMatchFn(matchNode, nameOrCtor, expectedNameOrCtor, key, expectedKey) {
    // Key check is done using double equals as we want to treat a null key the
    // same as undefined. This should be okay as the only values allowed are
    // strings, null and undefined so the == semantics are not too weird.
    return nameOrCtor == expectedNameOrCtor && key == expectedKey;
}
let context = null;
let currentNode = null;
let currentParent = null;
let doc = null;
let focusPath = [];
let matchFn = defaultMatchFn;
/**
 * Used to build up call arguments. Each patch call gets a separate copy, so
 * this works with nested calls to patch.
 */
let argsBuilder = [];
/**
 * Used to build up attrs for the an element.
 */
let attrsBuilder = [];
/**
 * TODO(sparhami) We should just export argsBuilder directly when Closure
 * Compiler supports ES6 directly.
 * @returns The Array used for building arguments.
 */
function getArgsBuilder() {
    return argsBuilder;
}
/**
 * TODO(sparhami) We should just export attrsBuilder directly when Closure
 * Compiler supports ES6 directly.
 * @returns The Array used for building arguments.
 */
function getAttrsBuilder() {
    return attrsBuilder;
}
/**
 * Checks whether or not the current node matches the specified nameOrCtor and
 * key. This uses the specified match function when creating the patcher.
 * @param matchNode A node to match the data to.
 * @param nameOrCtor The name or constructor to check for.
 * @param key The key used to identify the Node.
 * @return True if the node matches, false otherwise.
 */
function matches(matchNode, nameOrCtor, key) {
    const data = nodeDataModule.getData(matchNode, key);
    return matchFn(matchNode, nameOrCtor, data.nameOrCtor, key, data.key);
}
/**
 * Finds the matching node, starting at `node` and looking at the subsequent
 * siblings if a key is used.
 * @param matchNode The node to start looking at.
 * @param nameOrCtor The name or constructor for the Node.
 * @param key The key used to identify the Node.
 * @returns The matching Node, if any exists.
 */
function getMatchingNode(matchNode, nameOrCtor, key) {
    if (!matchNode) {
        return null;
    }
    let cur = matchNode;
    do {
        if (matches(cur, nameOrCtor, key)) {
            return cur;
        }
    } while (key && (cur = cur.nextSibling));
    return null;
}
/**
 * Clears out any unvisited Nodes in a given range.
 * @param maybeParentNode
 * @param startNode The node to start clearing from, inclusive.
 * @param endNode The node to clear until, exclusive.
 */
function clearUnvisitedDOM(maybeParentNode, startNode, endNode) {
    const parentNode = maybeParentNode;
    let child = startNode;
    while (child !== endNode) {
        const next = child.nextSibling;
        parentNode.removeChild(child);
        context.markDeleted(child);
        child = next;
    }
}
/**
 * @return The next Node to be patched.
 */
function getNextNode() {
    if (currentNode) {
        return currentNode.nextSibling;
    }
    else {
        return currentParent.firstChild;
    }
}
/**
 * Changes to the first child of the current node.
 */
function enterNode() {
    currentParent = currentNode;
    currentNode = null;
}
/**
 * Changes to the parent of the current node, removing any unvisited children.
 */
function exitNode() {
    clearUnvisitedDOM(currentParent, getNextNode(), null);
    currentNode = currentParent;
    currentParent = currentParent.parentNode;
}
/**
 * Changes to the next sibling of the current node.
 */
function nextNode() {
    currentNode = getNextNode();
}
/**
 * Creates a Node and marking it as created.
 * @param nameOrCtor The name or constructor for the Node.
 * @param key The key used to identify the Node.
 * @return The newly created node.
 */
function createNode(nameOrCtor, key) {
    let node;
    if (nameOrCtor === "#text") {
        node = nodesModule.createText(doc);
    }
    else {
        node = nodesModule.createElement(doc, currentParent, nameOrCtor, key);
    }
    context.markCreated(node);
    return node;
}
/**
 * Aligns the virtual Node definition with the actual DOM, moving the
 * corresponding DOM node to the correct location or creating it if necessary.
 * @param nameOrCtor The name or constructor for the Node.
 * @param key The key used to identify the Node.
 */
function alignWithDOM(nameOrCtor, key) {
    nextNode();
    const existingNode = getMatchingNode(currentNode, nameOrCtor, key);
    const node = existingNode || createNode(nameOrCtor, key);
    // If we are at the matching node, then we are done.
    if (node === currentNode) {
        return;
    }
    // Re-order the node into the right position, preserving focus if either
    // node or currentNode are focused by making sure that they are not detached
    // from the DOM.
    if (focusPath.indexOf(node) >= 0) {
        // Move everything else before the node.
        domUtilModule.moveBefore(currentParent, node, currentNode);
    }
    else {
        currentParent.insertBefore(node, currentNode);
    }
    currentNode = node;
}
/**
 * Makes sure that the current node is an Element with a matching nameOrCtor and
 * key.
 *
 * @param nameOrCtor The tag or constructor for the Element.
 * @param key The key used to identify this element. This can be an
 *     empty string, but performance may be better if a unique value is used
 *     when iterating over an array of items.
 * @return The corresponding Element.
 */
function open(nameOrCtor, key) {
    alignWithDOM(nameOrCtor, key);
    enterNode();
    return currentParent;
}
/**
 * Closes the currently open Element, removing any unvisited children if
 * necessary.
 * @returns The Element that was just closed.
 */
function close() {
    if (globalModule.DEBUG) {
        assertions.setInSkip(false);
    }
    exitNode();
    return currentNode;
}
/**
 * Makes sure the current node is a Text node and creates a Text node if it is
 * not.
 * @returns The Text node that was aligned or created.
 */
function text() {
    alignWithDOM("#text", null);
    return currentNode;
}
/**
 * @returns The current Element being patched.
 */
function currentElement() {
    if (globalModule.DEBUG) {
        assertions.assertInPatch("currentElement");
        assertions.assertNotInAttributes("currentElement");
    }
    return currentParent;
}
/**
 * @return The Node that will be evaluated for the next instruction.
 */
function currentPointer() {
    if (globalModule.DEBUG) {
        assertions.assertInPatch("currentPointer");
        assertions.assertNotInAttributes("currentPointer");
    }
    // TODO(tomnguyen): assert that this is not null
    return getNextNode();
}
/**
 * Skips the children in a subtree, allowing an Element to be closed without
 * clearing out the children.
 */
function skip() {
    if (globalModule.DEBUG) {
        assertions.assertNoChildrenDeclaredYet("skip", currentNode);
        assertions.setInSkip(true);
    }
    currentNode = currentParent.lastChild;
}
/**
 * Returns a patcher function that sets up and restores a patch context,
 * running the run function with the provided data.
 * @param run The function that will run the patch.
 * @param patchConfig The configuration to use for the patch.
 * @returns The created patch function.
 */
function createPatcher(run, patchConfig = {}) {
    const { matches = defaultMatchFn } = patchConfig;
    const f = (node, fn, data) => {
        const prevContext = context;
        const prevDoc = doc;
        const prevFocusPath = focusPath;
        const prevArgsBuilder = argsBuilder;
        const prevAttrsBuilder = attrsBuilder;
        const prevCurrentNode = currentNode;
        const prevCurrentParent = currentParent;
        const prevMatchFn = matchFn;
        let previousInAttributes = false;
        let previousInSkip = false;
        doc = node.ownerDocument;
        context = new contextModule.Context();
        matchFn = matches;
        argsBuilder = [];
        attrsBuilder = [];
        currentNode = null;
        currentParent = node.parentNode;
        focusPath = domUtilModule.getFocusedPath(node, currentParent);
        if (globalModule.DEBUG) {
            previousInAttributes = assertions.setInAttributes(false);
            previousInSkip = assertions.setInSkip(false);
            assertions.updatePatchContext(context);
        }
        try {
            const retVal = run(node, fn, data);
            if (globalModule.DEBUG) {
                assertions.assertVirtualAttributesClosed();
            }
            return retVal;
        }
        finally {
            context.notifyChanges();
            doc = prevDoc;
            context = prevContext;
            matchFn = prevMatchFn;
            argsBuilder = prevArgsBuilder;
            attrsBuilder = prevAttrsBuilder;
            currentNode = prevCurrentNode;
            currentParent = prevCurrentParent;
            focusPath = prevFocusPath;
            // Needs to be done after assertions because assertions rely on state
            // from these methods.
            if (globalModule.DEBUG) {
                assertions.setInAttributes(previousInAttributes);
                assertions.setInSkip(previousInSkip);
                assertions.updatePatchContext(context);
            }
        }
    };
    return f;
}
/**
 * Creates a patcher that patches the document starting at node with a
 * provided function. This function may be called during an existing patch operation.
 * @param patchConfig The config to use for the patch.
 * @returns The created function for patching an Element's children.
 */
function createPatchInner(patchConfig) {
    return createPatcher((node, fn, data) => {
        currentNode = node;
        enterNode();
        fn(data);
        exitNode();
        if (globalModule.DEBUG) {
            assertions.assertNoUnclosedTags(currentNode, node);
        }
        return node;
    }, patchConfig);
}
/**
 * Creates a patcher that patches an Element with the the provided function.
 * Exactly one top level element call should be made corresponding to `node`.
 * @param patchConfig The config to use for the patch.
 * @returns The created function for patching an Element.
 */
function createPatchOuter(patchConfig) {
    return createPatcher((node, fn, data) => {
        const startNode = { nextSibling: node };
        let expectedNextNode = null;
        let expectedPrevNode = null;
        if (globalModule.DEBUG) {
            expectedNextNode = node.nextSibling;
            expectedPrevNode = node.previousSibling;
        }
        currentNode = startNode;
        fn(data);
        if (globalModule.DEBUG) {
            assertions.assertPatchOuterHasParentNode(currentParent);
            assertions.assertPatchElementNoExtras(startNode, currentNode, expectedNextNode, expectedPrevNode);
        }
        if (currentParent) {
            clearUnvisitedDOM(currentParent, getNextNode(), node.nextSibling);
        }
        return startNode === currentNode ? null : currentNode;
    }, patchConfig);
}
const patchInner = createPatchInner();
const patchOuter = createPatchOuter();
