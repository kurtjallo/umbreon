const addForm = document.querySelector("#add-form");
const addTitle = document.querySelector("#add-title");
const addDescription = document.querySelector("#add-description");
const addButton = addForm.querySelector("button[type=submit]");
const statusEl = document.querySelector("#status");
const alertEl = document.querySelector("#alert");
const listArea = document.querySelector("#list-area");
const dialog = document.querySelector("#delete-dialog");
const dialogMessage = document.querySelector("#delete-message");
const dialogCancel = document.querySelector("#delete-cancel");
const dialogConfirm = document.querySelector("#delete-confirm");

const UPDATE_FAILED = "Couldn't update the task. Please try again.";
const TASK_GONE = "This task no longer exists.";

const state = {
  list: { kind: "loading" },
  message: null,
  adding: false,
  editing: null,
  toggling: new Map(),
  confirming: null,
};

let announcedMessage = null;
let loadCount = 0;

async function api(method, path, body) {
  try {
    const response = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = response.status === 204 ? {} : await response.json().catch(() => null);
    const clientError = response.status >= 400 && response.status < 500;
    return {
      ok: response.ok && data !== null,
      status: response.status,
      data,
      error: clientError && typeof data?.error === "string" ? data.error : null,
    };
  } catch {
    return { ok: false, status: 0, data: null, error: null };
  }
}

function h(tag, attributes, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (typeof value === "function") node.addEventListener(name.slice(2), value);
    else if (typeof value === "boolean") node.toggleAttribute(name, value);
    else node.setAttribute(name, value);
  }
  node.append(...children.filter(Boolean));
  return node;
}

function announce(kind, text) {
  state.message = { kind, text };
}

function refocus(key) {
  return document.activeElement === document.body ? key : undefined;
}

function replaceTask(task) {
  state.list = { kind: "ready", tasks: state.list.tasks.map((t) => (t.id === task.id ? task : t)) };
}

function removeTask(id) {
  state.list = { kind: "ready", tasks: state.list.tasks.filter((t) => t.id !== id) };
  if (state.editing?.id === id) state.editing = null;
}

function render(focusKey = document.activeElement?.dataset.key) {
  addButton.disabled = state.adding;

  if (state.message !== announcedMessage) {
    announcedMessage = state.message;
    statusEl.textContent = announcedMessage?.kind === "status" ? announcedMessage.text : "";
    alertEl.textContent = announcedMessage?.kind === "alert" ? announcedMessage.text : "";
  }

  if (state.confirming) {
    dialogMessage.textContent = `"${state.confirming.title}" will be permanently deleted.`;
    dialogCancel.disabled = state.confirming.deleting;
    dialogConfirm.disabled = state.confirming.deleting;
    if (!dialog.open) dialog.showModal();
  } else if (dialog.open) {
    dialog.close();
  }

  listArea.replaceChildren(...listContent());
  if (focusKey && !dialog.open) document.querySelector(`[data-key="${focusKey}"]`)?.focus();
}

function listContent() {
  const { list } = state;
  if (list.kind === "loading") return [h("p", { class: "list-message loading" }, "Loading tasks...")];
  if (list.kind === "error") {
    return [h("div", { class: "list-message" }, h("button", { type: "button", "data-key": "retry", onclick: () => load(true) }, "Try again"))];
  }
  if (list.tasks.length === 0) return [h("p", { class: "list-message" }, "No tasks yet. Add your first task above.")];

  const done = list.tasks.filter((task) => task.completed).length;
  return [
    h("p", { class: "summary" }, `${done} of ${list.tasks.length} done`),
    h("ul", { class: "tasks", "aria-label": "Tasks" }, ...list.tasks.map(taskRow)),
  ];
}

function taskRow(task) {
  const editing = state.editing?.id === task.id;
  return h(
    "li",
    { class: editing ? "task editing" : "task", "data-completed": String(task.completed) },
    ...(editing ? [editForm(state.editing)] : taskView(task)),
  );
}

function taskView(task) {
  const titleId = `task-${task.id}-title`;
  const pending = state.toggling.get(task.id);
  return [
    h(
      "label",
      { class: "check" },
      h("input", {
        type: "checkbox",
        "aria-labelledby": titleId,
        "data-key": `toggle-${task.id}`,
        checked: pending ?? task.completed,
        disabled: pending !== undefined,
        onchange: (event) => toggle(task, event.target.checked),
      }),
    ),
    h(
      "div",
      { class: "task-text" },
      h("span", { id: titleId, class: "task-title" }, task.title),
      task.description && h("p", { class: "task-description" }, task.description),
    ),
    h(
      "div",
      { class: "task-actions" },
      h("button", { type: "button", class: "quiet", "aria-label": `Edit ${task.title}`, "data-key": `edit-${task.id}`, onclick: () => startEdit(task) }, "Edit"),
      h("button", { type: "button", class: "quiet delete", "aria-label": `Delete ${task.title}`, "data-key": `delete-${task.id}`, onclick: () => askDelete(task) }, "Delete"),
    ),
  ];
}

function editForm(editing) {
  const { saving } = editing;
  return h(
    "form",
    {
      class: "edit-form",
      "aria-label": "Edit task",
      novalidate: true,
      onsubmit: (event) => {
        event.preventDefault();
        saveEdit();
      },
      onkeydown: (event) => {
        if (event.key === "Escape" && !event.isComposing) cancelEdit();
      },
    },
    h(
      "div",
      { class: "field" },
      h("label", { for: "edit-title" }, "Title"),
      h("input", {
        id: "edit-title",
        type: "text",
        maxlength: "200",
        autocomplete: "off",
        value: editing.title,
        disabled: saving,
        "data-key": "edit-title",
        oninput: (event) => {
          editing.title = event.target.value;
        },
      }),
    ),
    h(
      "div",
      { class: "field" },
      h("label", { for: "edit-description" }, "Description (optional)"),
      h(
        "textarea",
        {
          id: "edit-description",
          maxlength: "2000",
          rows: "3",
          disabled: saving,
          "data-key": "edit-description",
          oninput: (event) => {
            editing.description = event.target.value;
          },
        },
        editing.description,
      ),
    ),
    h(
      "div",
      { class: "form-actions" },
      h("button", { type: "button", disabled: saving, "data-key": "edit-cancel", onclick: cancelEdit }, "Cancel"),
      h("button", { type: "submit", class: "primary", disabled: saving, "data-key": "edit-save" }, "Save"),
    ),
  );
}

async function load(retrying = false) {
  const current = ++loadCount;
  state.list = { kind: "loading" };
  if (state.message?.kind === "alert") state.message = null;
  render();

  const response = await api("GET", "/api/tasks");
  if (current !== loadCount) return;
  if (response.ok && Array.isArray(response.data.tasks)) {
    state.list = { kind: "ready", tasks: response.data.tasks };
  } else {
    state.list = { kind: "error" };
    announce("alert", "Couldn't load tasks. Check your connection and try again.");
  }
  render(retrying && state.list.kind === "error" ? refocus("retry") : undefined);
}

async function toggle(task, completed) {
  state.toggling.set(task.id, completed);
  render();

  const response = await api("PATCH", `/api/tasks/${task.id}`, { completed });
  state.toggling.delete(task.id);
  if (response.ok) {
    replaceTask(response.data.task);
    announce("status", completed ? "Task marked complete." : "Task marked incomplete.");
  } else if (response.status === 404) {
    removeTask(task.id);
    announce("alert", TASK_GONE);
  } else {
    announce("alert", response.error ?? UPDATE_FAILED);
  }
  render(refocus(`toggle-${task.id}`));
}

function startEdit(task) {
  if (state.editing?.saving) return;
  state.editing = { id: task.id, title: task.title, description: task.description, saving: false };
  render("edit-title");
}

function cancelEdit() {
  if (state.editing.saving) return;
  const { id } = state.editing;
  state.editing = null;
  render(`edit-${id}`);
}

async function saveEdit() {
  const editing = state.editing;
  if (editing.saving) return;
  if (!editing.title.trim()) {
    announce("alert", "Title is required.");
    render("edit-title");
    return;
  }
  editing.saving = true;
  render();

  const response = await api("PATCH", `/api/tasks/${editing.id}`, {
    title: editing.title,
    description: editing.description,
  });
  editing.saving = false;
  if (response.ok) {
    replaceTask(response.data.task);
    state.editing = null;
    announce("status", "Task updated.");
    render(refocus(`edit-${editing.id}`));
  } else if (response.status === 404) {
    removeTask(editing.id);
    announce("alert", TASK_GONE);
    render();
  } else {
    announce("alert", response.error ?? UPDATE_FAILED);
    render(refocus("edit-title"));
  }
}

function askDelete(task) {
  state.confirming = { id: task.id, title: task.title, deleting: false };
  render();
}

addForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.adding) return;
  if (!addTitle.value.trim()) {
    announce("alert", "Title is required.");
    render("add-title");
    return;
  }
  state.adding = true;
  render();

  const response = await api("POST", "/api/tasks", {
    title: addTitle.value,
    description: addDescription.value,
  });
  state.adding = false;
  if (response.ok) {
    addForm.reset();
    announce("status", "Task added.");
    if (state.list.kind === "ready") state.list = { kind: "ready", tasks: [response.data.task, ...state.list.tasks] };
    else load();
    render("add-title");
  } else {
    announce("alert", response.error ?? "Couldn't add the task. Please try again.");
    render(refocus("add-title"));
  }
});

dialogCancel.addEventListener("click", () => dialog.close());

dialog.addEventListener("cancel", (event) => {
  if (state.confirming?.deleting) event.preventDefault();
});

dialog.addEventListener("close", () => {
  if (!state.confirming || state.confirming.deleting) return;
  const { id } = state.confirming;
  state.confirming = null;
  render(`delete-${id}`);
});

dialogConfirm.addEventListener("click", async () => {
  const confirming = state.confirming;
  if (confirming.deleting) return;
  confirming.deleting = true;
  render();

  const response = await api("DELETE", `/api/tasks/${confirming.id}`);
  state.confirming = null;
  if (response.ok || response.status === 404) {
    removeTask(confirming.id);
    announce("status", "Task deleted.");
    render("list");
  } else {
    announce("alert", "Couldn't delete the task. Please try again.");
    render(`delete-${confirming.id}`);
  }
});

load();
