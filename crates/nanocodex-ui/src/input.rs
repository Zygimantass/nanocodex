// Input protocol adapted from GPUI's Apache-2.0 examples/input.rs at
// 36682547bea1c3d4fa60c08d341cf60081853941. Multiline layout is local.
use gpui::{
    App, Bounds, ClipboardItem, Context, ElementInputHandler, EntityInputHandler, EventEmitter,
    FocusHandle, KeyBinding, MouseButton, Pixels, Point, SharedString, TextRun, UTF16Selection,
    Window, WrappedLine, actions, canvas, div, fill, point, prelude::*, px, rgba, size,
};
use std::ops::Range;
use unicode_segmentation::UnicodeSegmentation;

actions!(
    input,
    [
        Backspace,
        Delete,
        Left,
        Right,
        SelectLeft,
        SelectRight,
        SelectAll,
        Home,
        End,
        Paste,
        Copy,
        Cut,
        Submit,
        Newline
    ]
);

pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("backspace", Backspace, Some("Prompt")),
        KeyBinding::new("delete", Delete, Some("Prompt")),
        KeyBinding::new("left", Left, Some("Prompt")),
        KeyBinding::new("right", Right, Some("Prompt")),
        KeyBinding::new("shift-left", SelectLeft, Some("Prompt")),
        KeyBinding::new("shift-right", SelectRight, Some("Prompt")),
        KeyBinding::new("home", Home, Some("Prompt")),
        KeyBinding::new("end", End, Some("Prompt")),
        KeyBinding::new("enter", Submit, Some("Prompt")),
        KeyBinding::new("shift-enter", Newline, Some("Prompt")),
        KeyBinding::new("cmd-a", SelectAll, Some("Prompt")),
        KeyBinding::new("ctrl-a", SelectAll, Some("Prompt")),
        KeyBinding::new("cmd-c", Copy, Some("Prompt")),
        KeyBinding::new("ctrl-c", Copy, Some("Prompt")),
        KeyBinding::new("cmd-v", Paste, Some("Prompt")),
        KeyBinding::new("ctrl-v", Paste, Some("Prompt")),
        KeyBinding::new("cmd-x", Cut, Some("Prompt")),
        KeyBinding::new("ctrl-x", Cut, Some("Prompt")),
    ]);
}

pub enum InputEvent {
    Changed(String),
    Submit,
}
pub struct Input {
    focus: FocusHandle,
    text: String,
    selection: Range<usize>,
    reversed: bool,
    marked: Option<Range<usize>>,
    selecting: bool,
    layout: Option<Layout>,
    origin: Point<Pixels>,
}
impl EventEmitter<InputEvent> for Input {}

struct Layout {
    lines: Vec<WrappedLine>,
    height: Pixels,
}
impl Layout {
    fn position(&self, index: usize) -> Point<Pixels> {
        let mut start = 0;
        let mut y = px(0.);
        for line in &self.lines {
            if index <= start + line.len() {
                return line
                    .position_for_index(index - start, self.height)
                    .unwrap_or_default()
                    + point(px(0.), y);
            }
            start += line.len() + 1;
            y += line.size(self.height).height;
        }
        point(px(0.), y)
    }
    fn index(&self, position: Point<Pixels>) -> usize {
        let mut start = 0;
        let mut y = px(0.);
        for line in &self.lines {
            let height = line.size(self.height).height;
            if position.y < y + height {
                return start
                    + line
                        .closest_index_for_position(
                            point(position.x, (position.y - y).max(px(0.))),
                            self.height,
                        )
                        .unwrap_or_else(|i| i);
            }
            start += line.len() + 1;
            y += height;
        }
        start.saturating_sub(1)
    }
}

impl Input {
    pub fn new(text: String, cx: &mut Context<Self>) -> Self {
        Self {
            focus: cx.focus_handle(),
            selection: text.len()..text.len(),
            text,
            reversed: false,
            marked: None,
            selecting: false,
            layout: None,
            origin: point(px(0.), px(0.)),
        }
    }
    pub fn text(&self) -> &str {
        &self.text
    }
    pub fn set_text(&mut self, text: String, cx: &mut Context<Self>) {
        if self.text == text {
            return;
        }
        self.selection = text.len()..text.len();
        self.text = text;
        self.marked = None;
        self.reversed = false;
        cx.notify();
    }
    fn cursor(&self) -> usize {
        if self.reversed {
            self.selection.start
        } else {
            self.selection.end
        }
    }
    fn select(&mut self, index: usize, extend: bool, cx: &mut Context<Self>) {
        let anchor = if extend {
            if self.reversed {
                self.selection.end
            } else {
                self.selection.start
            }
        } else {
            index
        };
        self.selection = anchor.min(index)..anchor.max(index);
        self.reversed = index < anchor;
        cx.notify();
    }
    fn previous(&self) -> usize {
        self.text
            .grapheme_indices(true)
            .map(|(i, _)| i)
            .rev()
            .find(|i| *i < self.cursor())
            .unwrap_or(0)
    }
    fn next(&self) -> usize {
        self.text
            .grapheme_indices(true)
            .map(|(i, _)| i)
            .find(|i| *i > self.cursor())
            .unwrap_or(self.text.len())
    }
    fn left(&mut self, _: &Left, _: &mut Window, cx: &mut Context<Self>) {
        self.select(
            if self.selection.is_empty() {
                self.previous()
            } else {
                self.selection.start
            },
            false,
            cx,
        );
    }
    fn right(&mut self, _: &Right, _: &mut Window, cx: &mut Context<Self>) {
        self.select(
            if self.selection.is_empty() {
                self.next()
            } else {
                self.selection.end
            },
            false,
            cx,
        );
    }
    fn select_left(&mut self, _: &SelectLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.select(self.previous(), true, cx);
    }
    fn select_right(&mut self, _: &SelectRight, _: &mut Window, cx: &mut Context<Self>) {
        self.select(self.next(), true, cx);
    }
    fn all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        self.selection = 0..self.text.len();
        self.reversed = false;
        cx.notify();
    }
    fn home(&mut self, _: &Home, _: &mut Window, cx: &mut Context<Self>) {
        self.select(0, false, cx);
    }
    fn end(&mut self, _: &End, _: &mut Window, cx: &mut Context<Self>) {
        self.select(self.text.len(), false, cx);
    }
    fn backspace(&mut self, _: &Backspace, window: &mut Window, cx: &mut Context<Self>) {
        if self.selection.is_empty() {
            self.select(self.previous(), true, cx);
        }
        self.replace_text_in_range(None, "", window, cx);
    }
    fn delete(&mut self, _: &Delete, window: &mut Window, cx: &mut Context<Self>) {
        if self.selection.is_empty() {
            self.select(self.next(), true, cx);
        }
        self.replace_text_in_range(None, "", window, cx);
    }
    fn newline(&mut self, _: &Newline, window: &mut Window, cx: &mut Context<Self>) {
        self.replace_text_in_range(None, "\n", window, cx);
    }
    fn submit(&mut self, _: &Submit, _: &mut Window, cx: &mut Context<Self>) {
        if self.marked.is_none() {
            cx.emit(InputEvent::Submit);
        }
    }
    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selection.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.text[self.selection.clone()].into(),
            ));
        }
    }
    fn cut(&mut self, _: &Cut, window: &mut Window, cx: &mut Context<Self>) {
        self.copy(&Copy, window, cx);
        self.replace_text_in_range(None, "", window, cx);
    }
    fn paste(&mut self, _: &Paste, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|i| i.text()) {
            self.replace_text_in_range(None, &text, window, cx);
        }
    }
    fn at(&self, position: Point<Pixels>) -> usize {
        self.layout
            .as_ref()
            .map(|l| l.index(position - self.origin).min(self.text.len()))
            .unwrap_or(0)
    }
    fn changed(&mut self, cx: &mut Context<Self>) {
        self.reversed = false;
        cx.emit(InputEvent::Changed(self.text.clone()));
        cx.notify();
    }
    fn bytes(&self, r: Range<usize>) -> Range<usize> {
        utf8_offset(&self.text, r.start)..utf8_offset(&self.text, r.end)
    }
    fn utf16(&self, r: Range<usize>) -> Range<usize> {
        self.text[..r.start].encode_utf16().count()..self.text[..r.end].encode_utf16().count()
    }
}

fn utf8_offset(text: &str, utf16: usize) -> usize {
    let mut units = 0;
    for (i, c) in text.char_indices() {
        if units >= utf16 {
            return i;
        }
        units += c.len_utf16();
    }
    text.len()
}

impl EntityInputHandler for Input {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        actual: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let r = self.bytes(range);
        *actual = Some(self.utf16(r.clone()));
        Some(self.text[r].into())
    }
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.utf16(self.selection.clone()),
            reversed: self.reversed,
        })
    }
    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.clone().map(|r| self.utf16(r))
    }
    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.marked = None;
        cx.notify();
    }
    fn replace_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let r = range
            .map(|r| self.bytes(r))
            .or(self.marked.clone())
            .unwrap_or(self.selection.clone());
        self.text.replace_range(r.clone(), text);
        self.selection = r.start + text.len()..r.start + text.len();
        self.marked = None;
        self.changed(cx);
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        selected: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let r = range
            .map(|r| self.bytes(r))
            .or(self.marked.clone())
            .unwrap_or(self.selection.clone());
        self.text.replace_range(r.clone(), text);
        self.marked = (!text.is_empty()).then_some(r.start..r.start + text.len());
        self.selection = selected
            .map(|s| r.start + utf8_offset(text, s.start)..r.start + utf8_offset(text, s.end))
            .unwrap_or(r.start + text.len()..r.start + text.len());
        self.changed(cx);
    }
    fn bounds_for_range(
        &mut self,
        range: Range<usize>,
        _: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let r = self.bytes(range);
        let layout = self.layout.as_ref()?;
        let p = self.origin + layout.position(r.start);
        let end = self.origin + layout.position(r.end);
        Some(Bounds::new(
            p,
            size((end.x - p.x).max(px(1.)), layout.height),
        ))
    }
    fn character_index_for_point(
        &mut self,
        point: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        Some(self.text[..self.at(point)].encode_utf16().count())
    }
}

impl Render for Input {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let entity = cx.entity();
        let paint_entity = entity.clone();
        div()
            .id("prompt")
            .key_context("Prompt")
            .track_focus(&self.focus)
            .cursor_text()
            .h(px(88.))
            .w_full()
            .overflow_hidden()
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::all))
            .on_action(cx.listener(Self::home))
            .on_action(cx.listener(Self::end))
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::submit))
            .on_action(cx.listener(Self::newline))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, e: &gpui::MouseDownEvent, window, cx| {
                    window.focus(&this.focus, cx);
                    this.selecting = true;
                    this.select(this.at(e.position), e.modifiers.shift, cx);
                }),
            )
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _, _, _| this.selecting = false),
            )
            .on_mouse_up_out(
                MouseButton::Left,
                cx.listener(|this, _, _, _| this.selecting = false),
            )
            .on_mouse_move(cx.listener(|this, e: &gpui::MouseMoveEvent, _, cx| {
                if this.selecting {
                    this.select(this.at(e.position), true, cx);
                }
            }))
            .child(
                canvas(
                    move |bounds, window, cx| {
                        let input = entity.read(cx);
                        let style = window.text_style();
                        let text: SharedString = if input.text.is_empty() {
                            "Ask Nanocodex…".into()
                        } else {
                            input.text.clone().into()
                        };
                        let run = TextRun {
                            len: text.len(),
                            font: style.font(),
                            color: if input.text.is_empty() {
                                rgba(0x849184ff).into()
                            } else {
                                style.color
                            },
                            background_color: None,
                            underline: None,
                            strikethrough: None,
                        };
                        let lines = window
                            .text_system()
                            .shape_text(text, px(15.), &[run], Some(bounds.size.width), None)
                            .expect("prompt layout")
                            .into_vec();
                        Layout {
                            lines,
                            height: px(22.),
                        }
                    },
                    move |bounds, layout, window, cx| {
                        let input = paint_entity.read(cx);
                        let cursor = layout.position(input.cursor());
                        let scroll = (cursor.y + layout.height - bounds.size.height).max(px(0.));
                        let origin = bounds.origin - point(px(0.), scroll);
                        let focused_cursor =
                            input.focus.is_focused(window) && input.selection.is_empty();
                        window.handle_input(
                            &input.focus,
                            ElementInputHandler::new(bounds, paint_entity.clone()),
                            cx,
                        );
                        for (index, text) in input.text.grapheme_indices(true) {
                            if index >= input.selection.end
                                || index + text.len() <= input.selection.start
                            {
                                continue;
                            }
                            let a = layout.position(index);
                            let b = layout.position(index + text.len());
                            let width = if a.y == b.y {
                                (b.x - a.x).max(px(2.))
                            } else {
                                (bounds.size.width - a.x).max(px(2.))
                            };
                            window.paint_quad(fill(
                                Bounds::new(origin + a, size(width, layout.height)),
                                rgba(0x7baa8255),
                            ));
                        }
                        let mut y = px(0.);
                        for line in &layout.lines {
                            let _ = line.paint(
                                origin + point(px(0.), y),
                                layout.height,
                                gpui::TextAlign::Left,
                                Some(bounds),
                                window,
                                cx,
                            );
                            y += line.size(layout.height).height;
                        }
                        if focused_cursor {
                            window.paint_quad(fill(
                                Bounds::new(origin + cursor, size(px(1.5), layout.height)),
                                window.text_style().color,
                            ));
                        }
                        paint_entity.update(cx, |input, _| {
                            input.layout = Some(layout);
                            input.origin = origin;
                        });
                    },
                )
                .size_full(),
            )
    }
}
