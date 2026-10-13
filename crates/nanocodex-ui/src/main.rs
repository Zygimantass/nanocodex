#[cfg(target_family = "wasm")]
fn main() {}

#[cfg(not(target_family = "wasm"))]
fn main() {
    use gpui::{AppContext, Bounds, WindowBounds, WindowOptions, px, size};
    use nanocodex_ui::{Dispatch, Snapshot, Workspace};
    use std::{
        io::{self, BufRead, Write},
        rc::Rc,
    };
    if std::env::args().nth(1).as_deref() != Some("--stdio") {
        eprintln!("Usage: nanocodex-ui --stdio (v1 snapshots on stdin, actions on stdout)");
        std::process::exit(2);
    }
    let (sender, receiver) = async_channel::bounded(32);
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else {
                break;
            };
            match serde_json::from_str::<Snapshot>(&line) {
                Ok(snapshot) if snapshot.version == 1 => {
                    if sender.send_blocking(snapshot).is_err() {
                        break;
                    }
                }
                Ok(_) => eprintln!("unsupported snapshot version"),
                Err(error) => eprintln!("invalid snapshot: {error}"),
            }
        }
    });
    gpui_platform::application().run(move |cx| {
        nanocodex_ui::configure(cx);
        let dispatch: Dispatch = Rc::new(|action| {
            let mut out = io::stdout().lock();
            if serde_json::to_writer(&mut out, &action).is_ok() {
                let _ = writeln!(out);
                let _ = out.flush();
            }
        });
        let bounds = Bounds::centered(None, size(px(1180.), px(780.)), cx);
        let window = cx
            .open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    titlebar: Some(gpui::TitlebarOptions {
                        title: Some("Nanocodex · Agents".into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                |_, cx| cx.new(|cx| Workspace::new(Snapshot::default(), dispatch, cx)),
            )
            .expect("GPUI native window");
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        cx.spawn(async move |cx| {
            while let Ok(snapshot) = receiver.recv().await {
                if window
                    .update(cx, |view, _, cx| view.update(snapshot, cx))
                    .is_err()
                {
                    return;
                }
            }
            let _ = cx.update(|cx| cx.quit());
        })
        .detach();
    });
}
