// Modified by NtTestAlert for the GPUI Fast fork.
use std::{cell::Cell, rc::Rc};

use crate::{
    AnyElement, Context, InteractiveElement as _, IntoElement, MouseButton, ParentElement as _,
    Render, TestAppContext, Window, div,
};

fn element_with_capture(owner: &Rc<()>) -> AnyElement {
    let captured = owner.clone();
    div()
        .on_mouse_down(MouseButton::Left, move |_, _, _| {
            let _ = &captured;
        })
        .into_any_element()
}

#[test]
fn discarded_off_frame_elements_release_captures() {
    let owner = Rc::new(());
    for _ in 0..64 {
        drop(element_with_capture(&owner));
    }
    assert_eq!(Rc::strong_count(&owner), 1);
}

#[test]
fn drawn_elements_release_frame_and_prebuilt_captures() {
    struct Host {
        owner: Rc<()>,
        prebuilt: Option<AnyElement>,
    }

    impl Render for Host {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            let before = Rc::strong_count(&self.owner);
            drop(element_with_capture(&self.owner));
            assert_eq!(Rc::strong_count(&self.owner), before + 1);
            div().children(self.prebuilt.take())
        }
    }

    let owner = Rc::new(());
    let prepaints = Rc::new(Cell::new(0));
    let observed = prepaints.clone();
    let prebuilt = div()
        .on_children_prepainted(move |_, _, _| observed.set(observed.get() + 1))
        .into_any_element();
    let mut cx = TestAppContext::single();
    cx.add_window(|_, _| Host {
        owner: owner.clone(),
        prebuilt: Some(prebuilt),
    });
    cx.run_until_parked();
    assert_eq!(prepaints.get(), 1);
    assert_eq!(Rc::strong_count(&prepaints), 1);
    assert_eq!(Rc::strong_count(&owner), 2);
}
