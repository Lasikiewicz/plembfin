import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { state, elements } = await import("../public/modules/state.js");
const { initMediaDetail, prepareInlineMediaDetail } = await import("../public/modules/media-detail-context.js");

function classListStub() {
  return {
    add() {},
    remove() {},
    contains() { return false; },
  };
}

function installMediaDetailDomStubs() {
  globalThis.document.getElementById = () => null;
  globalThis.document.querySelector = () => null;
  elements.explorerPanel = {
    innerHTML: "",
    scrollIntoView() {},
  };
  elements.explorerTopbarControls = { classList: classListStub() };
  elements.alphaFilterNav = { classList: classListStub() };
}

test("preparing an already-routed inline detail does not re-enter the route", () => {
  installMediaDetailDomStubs();
  let selectViewCalls = 0;
  initMediaDetail({ selectView: () => { selectViewCalls += 1; } });

  state.activeView = "explorer";
  state.explorerMode = "shows";
  state.mediaDetailInline = true;
  prepareInlineMediaDetail("shows");

  assert.equal(selectViewCalls, 0);
});

test("preparing a detail from a normal view still selects Explorer", () => {
  installMediaDetailDomStubs();
  let selectViewCalls = 0;
  initMediaDetail({ selectView: () => { selectViewCalls += 1; } });

  state.activeView = "dashboard";
  state.explorerMode = "movies";
  state.mediaDetailInline = false;
  prepareInlineMediaDetail("movies");

  assert.equal(selectViewCalls, 1);
});
