mod input;

use gpui::{
    App, AppContext, Context, Entity, FontWeight, SharedString, Subscription, Window, div,
    prelude::*, px, rgb,
};
use input::{Input, InputEvent};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::rc::Rc;

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Snapshot {
    pub version: u32,
    pub scope: String,
    pub theme: String,
    pub connected: bool,
    pub busy: bool,
    pub error: Option<String>,
    pub selected_id: Option<String>,
    pub agents: Vec<AgentCard>,
    pub messages: Vec<Message>,
    pub loading_history: bool,
    pub draft: String,
    pub model_label: String,
    pub running: bool,
    pub pending: Vec<Pending>,
    pub can_load_older: bool,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentCard {
    pub id: String,
    pub title: String,
    pub last_user_message_at: f64,
    pub status: String,
    pub activity: String,
    pub prompt: String,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default)]
pub struct Message {
    pub id: String,
    pub role: String,
    pub text: String,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default)]
pub struct Pending {
    pub id: String,
    pub text: String,
    pub state: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    Select {
        id: String,
    },
    New,
    Draft {
        id: String,
        text: String,
    },
    Send {
        id: String,
        text: String,
        mode: String,
    },
    Cancel {
        id: String,
    },
    CancelPending {
        id: String,
        #[serde(rename = "pendingId")]
        pending_id: String,
    },
    Navigate {
        destination: String,
    },
    Refresh,
    Older {
        id: String,
    },
    Theme,
}

pub type Dispatch = Rc<dyn Fn(Action)>;

pub struct Workspace {
    snapshot: Snapshot,
    input: Entity<Input>,
    dispatch: Dispatch,
    running_only: bool,
    show_list: bool,
    pending_drafts: VecDeque<String>,
    submitted_draft: Option<String>,
    transcript_scroll: gpui::ScrollHandle,
    _input_subscription: Subscription,
}

impl Workspace {
    pub fn new(snapshot: Snapshot, dispatch: Dispatch, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| Input::new(snapshot.draft.clone(), cx));
        let subscription = cx.subscribe(&input, |this, _, event, cx| match event {
            InputEvent::Changed(text) => {
                if let Some(id) = &this.snapshot.selected_id {
                    this.pending_drafts.push_back(text.clone());
                    (this.dispatch)(Action::Draft {
                        id: id.clone(),
                        text: text.clone(),
                    });
                }
                cx.notify();
            }
            InputEvent::Submit => this.submit(cx),
        });
        Self {
            show_list: snapshot.selected_id.is_none(),
            snapshot,
            input,
            dispatch,
            running_only: false,
            pending_drafts: VecDeque::new(),
            submitted_draft: None,
            transcript_scroll: gpui::ScrollHandle::new(),
            _input_subscription: subscription,
        }
    }

    pub fn update(&mut self, snapshot: Snapshot, cx: &mut Context<Self>) {
        if snapshot.version != 1 {
            return;
        }
        let changed = snapshot.selected_id != self.snapshot.selected_id;
        let submitted_clear = snapshot.draft.is_empty()
            && self.submitted_draft.as_deref() == Some(self.input.read(cx).text());
        // A host can acknowledge "a" after the user has already typed "ab".
        // Consume echoes without replacing a locally newer draft.
        let echo = self
            .pending_drafts
            .iter()
            .position(|text| text == &snapshot.draft);
        let apply_draft =
            changed || submitted_clear || (echo.is_none() && self.pending_drafts.is_empty());
        if changed || submitted_clear {
            self.pending_drafts.clear();
            self.submitted_draft = None;
        } else if let Some(index) = echo {
            self.pending_drafts.drain(..=index);
        }
        if apply_draft {
            self.input
                .update(cx, |input, cx| input.set_text(snapshot.draft.clone(), cx));
        }
        if changed {
            self.show_list = snapshot.selected_id.is_none();
            self.transcript_scroll = gpui::ScrollHandle::new();
        }
        let follow = changed
            || -self.transcript_scroll.offset().y
                >= self.transcript_scroll.max_offset().y - px(24.);
        let count = snapshot.messages.len();
        self.snapshot = snapshot;
        if follow && count > 0 {
            self.transcript_scroll.scroll_to_bottom();
        }
        cx.notify();
    }

    fn submit(&mut self, cx: &mut Context<Self>) {
        self.send(
            if self.snapshot.running {
                "queue"
            } else {
                "send"
            },
            cx,
        );
    }

    fn send(&mut self, mode: &str, cx: &mut Context<Self>) {
        if !self.snapshot.connected || self.snapshot.busy {
            return;
        }
        if let Some(id) = &self.snapshot.selected_id {
            let text = self.input.read(cx).text().to_owned();
            if !text.trim().is_empty() {
                self.submitted_draft = Some(text.clone());
                (self.dispatch)(Action::Send {
                    id: id.clone(),
                    text,
                    mode: mode.into(),
                });
            }
        }
    }

    fn button(
        &self,
        id: impl Into<gpui::ElementId>,
        text: impl Into<SharedString>,
        action: Action,
        cx: &Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let dispatch = self.dispatch.clone();
        let dark = self.snapshot.theme == "dark";
        div()
            .id(id)
            .px_3()
            .py_2()
            .rounded_md()
            .cursor_pointer()
            .hover(move |s| s.bg(rgb(if dark { 0x292c30 } else { 0xe9ebe8 })))
            .on_click(cx.listener(move |_, _, _, _| dispatch(action.clone())))
            .child(text.into())
    }
}

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let dark = self.snapshot.theme == "dark";
        let bg = rgb(if dark { 0x151719 } else { 0xfafbf9 });
        let panel = rgb(if dark { 0x1b1e20 } else { 0xf0f2ef });
        let border = rgb(if dark { 0x303437 } else { 0xdfe3dd });
        let text = rgb(if dark { 0xe6e9e3 } else { 0x252b25 });
        let muted = rgb(if dark { 0x929c93 } else { 0x657164 });
        let accent = rgb(if dark { 0xa7c9a8 } else { 0x3e6946 });
        let narrow = window.viewport_size().width < px(760.);
        let selected = self.snapshot.selected_id.clone();
        let running_count = self
            .snapshot
            .agents
            .iter()
            .filter(|a| matches!(a.status.as_str(), "running" | "stopping"))
            .count();
        let mut agents: Vec<_> = self
            .snapshot
            .agents
            .iter()
            .filter(|a| !self.running_only || matches!(a.status.as_str(), "running" | "stopping"))
            .collect();
        agents.sort_by(|a, b| {
            b.last_user_message_at
                .total_cmp(&a.last_user_message_at)
                .then(a.id.cmp(&b.id))
        });
        let list = div()
            .flex()
            .flex_col()
            .flex_shrink_0()
            .w(if narrow {
                window.viewport_size().width
            } else {
                px(286.)
            })
            .h_full()
            .bg(panel)
            .border_r_1()
            .border_color(border)
            .child(
                div()
                    .px_5()
                    .pt_5()
                    .pb_3()
                    .text_lg()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("nanocodex"),
            )
            .child(
                div()
                    .px_3()
                    .flex()
                    .gap_1()
                    .text_sm()
                    .text_color(muted)
                    .child(self.button(
                        "home",
                        "Home",
                        Action::Navigate {
                            destination: "home".into(),
                        },
                        cx,
                    ))
                    .child(div().px_3().py_2().text_color(text).child("Agents"))
                    .child(self.button(
                        "account",
                        "Account",
                        Action::Navigate {
                            destination: "account".into(),
                        },
                        cx,
                    )),
            )
            .child(
                div()
                    .px_5()
                    .pt_7()
                    .pb_3()
                    .flex()
                    .justify_between()
                    .items_center()
                    .child(
                        div()
                            .text_xl()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Agents"),
                    )
                    .child(
                        self.button("new", "+ New", Action::New, cx)
                            .text_sm()
                            .text_color(accent),
                    ),
            )
            .child(
                div()
                    .mx_4()
                    .mb_3()
                    .flex()
                    .gap_1()
                    .text_sm()
                    .child(
                        div()
                            .id("all")
                            .px_3()
                            .py_2()
                            .rounded_md()
                            .cursor_pointer()
                            .when(!self.running_only, |s| s.bg(bg))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.running_only = false;
                                cx.notify();
                            }))
                            .child("All"),
                    )
                    .child(
                        div()
                            .id("running")
                            .px_3()
                            .py_2()
                            .rounded_md()
                            .cursor_pointer()
                            .when(self.running_only, |s| s.bg(bg))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.running_only = true;
                                cx.notify();
                            }))
                            .child(format!("Running  {running_count}")),
                    ),
            )
            .child(
                div()
                    .id("agent-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px_3()
                    .children(agents.iter().map(|agent| {
                        let id = agent.id.clone();
                        let dispatch = self.dispatch.clone();
                        div()
                            .id(SharedString::from(format!("agent-{id}")))
                            .p_3()
                            .mb_1()
                            .rounded_lg()
                            .cursor_pointer()
                            .when(selected.as_ref() == Some(&id), |s| {
                                s.bg(bg).border_1().border_color(border)
                            })
                            .hover(|s| s.bg(bg))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.show_list = false;
                                dispatch(Action::Select { id: id.clone() });
                                cx.notify();
                            }))
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .overflow_hidden()
                                    .text_ellipsis()
                                    .child(agent.title.clone()),
                            )
                            .child(
                                div()
                                    .mt_1()
                                    .text_xs()
                                    .text_color(muted)
                                    .overflow_hidden()
                                    .text_ellipsis()
                                    .child(if agent.activity.is_empty() {
                                        agent.prompt.clone()
                                    } else {
                                        agent.activity.clone()
                                    }),
                            )
                            .child(
                                div()
                                    .mt_2()
                                    .text_xs()
                                    .text_color(
                                        if matches!(agent.status.as_str(), "running" | "stopping") {
                                            accent
                                        } else {
                                            muted
                                        },
                                    )
                                    .child(agent.status.clone()),
                            )
                    }))
                    .when(agents.is_empty(), |s| {
                        s.child(div().p_3().text_sm().text_color(muted).child(
                            if self.running_only {
                                "No agents running."
                            } else {
                                "No agents yet. Start a new one."
                            },
                        ))
                    }),
            )
            .child(
                div()
                    .p_3()
                    .border_t_1()
                    .border_color(border)
                    .flex()
                    .justify_between()
                    .text_xs()
                    .text_color(muted)
                    .child(self.button(
                        "refresh",
                        if self.snapshot.busy {
                            "Connecting…"
                        } else {
                            "Refresh"
                        },
                        Action::Refresh,
                        cx,
                    ))
                    .child(self.button(
                        "theme",
                        if dark { "Light" } else { "Dark" },
                        Action::Theme,
                        cx,
                    )),
            );
        let title = self
            .snapshot
            .agents
            .iter()
            .find(|a| Some(&a.id) == selected.as_ref())
            .map(|a| a.title.clone())
            .unwrap_or_else(|| "New agent".into());
        let loading_history = selected.is_some()
            && (self.snapshot.loading_history || self.snapshot.busy || !self.snapshot.connected);
        let dispatch = self.dispatch.clone();
        let detail = div().flex_1().min_w_0().h_full().flex().flex_col()
            .child(div().h(px(76.)).flex_shrink_0().px_6().border_b_1().border_color(border).flex().items_center().justify_between()
                .child(div().flex().gap_3().items_center()
                    .when(narrow, |s| s.child(div().id("back").cursor_pointer().p_2().child("‹ Agents").on_click(cx.listener(|this, _, _, cx| { this.show_list = true; cx.notify(); }))))
                    .child(div().child(div().font_weight(FontWeight::SEMIBOLD).child(title))
                        .child(div().mt_1().text_xs().text_color(muted).child(self.snapshot.scope.clone()))))
                .child(self.button("tools", "Tools ↗", Action::Navigate { destination: "tools".into() }, cx).text_sm().text_color(muted)))
            .when_some(self.snapshot.error.clone(), |s, error| s.child(div().px_6().py_3().bg(panel).text_sm().text_color(accent).child(error)
                .child(self.button("retry", "Retry", Action::Refresh, cx))))
            .child(div().id("conversation").track_scroll(&self.transcript_scroll).flex_1().min_h_0().overflow_y_scroll().px_6().py_6()
                .when(self.snapshot.can_load_older, |s| s.child(self.button("older", "Load older messages", Action::Older { id: selected.clone().unwrap_or_default() }, cx).text_sm().text_color(muted)))
                .when(self.snapshot.messages.is_empty(), |s| s.child(div().py(px(64.)).max_w(px(680.)).mx_auto()
                    .child(div().text_xs().text_color(accent).child("NANOCODEX / AGENTS"))
                    .child(div().mt_4().text_3xl().font_weight(FontWeight::SEMIBOLD).child(if loading_history { "Loading conversation…" } else if selected.is_some() { "What should we work on?" } else { "Your work, across devices." }))
                    .child(div().mt_4().text_color(muted).child(if loading_history { "Fetching saved messages." } else if selected.is_some() { "Ask a question, make a change, or pick up where you left off." } else { "Open an agent or start a new one. Your conversations stay with you." }))))
                .children(self.snapshot.messages.iter().map(|message| {
                    let user = message.role == "user";
                    let tool = matches!(message.role.as_str(), "tool" | "reasoning");
                    div().id(SharedString::from(message.id.clone())).max_w(px(760.)).mx_auto().mb_6()
                        .child(div().mb_2().text_xs().text_color(muted).child(if user { "YOU" } else if tool { "ACTIVITY" } else { "NANOCODEX" }))
                        .child(div().text_size(px(15.)).line_height(px(24.)).when(user, |s| s.bg(panel).p_4().rounded_lg())
                            .when(tool, |s| s.text_color(muted).text_sm())
                            .child(message.text.clone()))
                }))
                .when(self.snapshot.running, |s| s.child(div().max_w(px(760.)).mx_auto().text_sm().text_color(accent).child("●  Working…"))))
            .when(selected.is_some(), |s| s.child(div().flex_shrink_0().px_6().pb_5().pt_3()
                .children(self.snapshot.pending.iter().map(|pending| {
                    let dispatch = dispatch.clone();
                    let action = Action::CancelPending { id: selected.clone().unwrap_or_default(), pending_id: pending.id.clone() };
                    div().max_w(px(760.)).mx_auto().mb_2().flex().gap_3().text_sm().text_color(muted)
                        .child(format!("{} · {}", if pending.state == "cancelling" { "Cancelling" } else { "Queued" }, pending.text))
                        .child(div().id(SharedString::from(format!("cancel-{}", pending.id))).cursor_pointer().child("×").on_click(move |_, _, _| dispatch(action.clone())))
                }))
                .child(div().max_w(px(760.)).mx_auto().p_4().rounded_xl().border_1().border_color(border).bg(panel)
                    .child(self.input.clone())
                    .child(div().mt_3().flex().items_center().justify_between().text_xs().text_color(muted)
                        .child(format!("{} · Shift+Enter for a new line", self.snapshot.model_label))
                        .child(div().flex().gap_2().items_center()
                            .when(self.snapshot.running, |s| s
                                .child(self.button("stop", "Stop", Action::Cancel { id: selected.clone().unwrap_or_default() }, cx))
                                .child(div().id("steer").px_3().py_2().cursor_pointer().child("Steer").on_click(cx.listener(|this, _, _, cx| this.send("steer", cx)))))
                            .child(div().id("send").px_4().py_2().rounded_md().bg(accent).text_color(bg).cursor_pointer()
                                .on_click(cx.listener(|this, _, _, cx| this.submit(cx)))
                                .child(if self.snapshot.running { "Queue ↑" } else { "Send ↑" })))))));
        div()
            .size_full()
            .flex()
            .font_family("IBM Plex Sans")
            .text_size(px(14.))
            .bg(bg)
            .text_color(text)
            .when(!narrow || self.show_list, |s| s.child(list))
            .when(!narrow || !self.show_list, |s| s.child(detail))
    }
}

pub fn configure(cx: &mut App) {
    use std::borrow::Cow;
    cx.text_system()
        .add_fonts(vec![
            Cow::Borrowed(include_bytes!("../fonts/IBMPlexSans-Regular.ttf")),
            Cow::Borrowed(include_bytes!("../fonts/IBMPlexSans-SemiBold.ttf")),
        ])
        .expect("bundled UI fonts");
    input::bind_keys(cx);
}

#[cfg(target_family = "wasm")]
mod web {
    use super::*;
    use std::cell::RefCell;
    use wasm_bindgen::prelude::*;
    thread_local! {
        static VIEW: RefCell<Option<(gpui::WeakEntity<Workspace>, gpui::AsyncApp)>> = const { RefCell::new(None) };
    }

    #[wasm_bindgen]
    pub fn mount(snapshot: &str, on_action: js_sys::Function) -> Result<(), JsValue> {
        let snapshot: Snapshot =
            serde_json::from_str(snapshot).map_err(|e| JsValue::from_str(&e.to_string()))?;
        gpui_platform::web_init();
        gpui_platform::single_threaded_web().run(move |cx| {
            configure(cx);
            let dispatch: Dispatch = Rc::new(move |action| {
                if let Ok(json) = serde_json::to_string(&action) {
                    let _ = on_action.call1(&JsValue::NULL, &JsValue::from_str(&json));
                }
            });
            let window = cx
                .open_window(Default::default(), |_, cx| {
                    cx.new(|cx| Workspace::new(snapshot, dispatch, cx))
                })
                .expect("GPUI browser window");
            let view = window
                .update(cx, |_, _, cx| cx.entity().downgrade())
                .expect("GPUI view");
            VIEW.with(|slot| *slot.borrow_mut() = Some((view, cx.to_async())));
        });
        Ok(())
    }

    #[wasm_bindgen]
    pub fn update(snapshot: &str) -> Result<bool, JsValue> {
        let snapshot: Snapshot =
            serde_json::from_str(snapshot).map_err(|e| JsValue::from_str(&e.to_string()))?;
        VIEW.with(|slot| {
            let mut slot = slot.borrow_mut();
            if let Some((view, cx)) = slot.as_mut() {
                view.update(cx, |view, cx| view.update(snapshot, cx))
                    .map_err(|e| JsValue::from_str(&e.to_string()))?;
                Ok(true)
            } else {
                Ok(false)
            }
        })
    }
}
