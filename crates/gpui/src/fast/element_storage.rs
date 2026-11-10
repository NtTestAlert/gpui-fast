//! Storage for elements created during a frame and independently of a frame.

use std::{
    any::Any,
    ops::{Deref, DerefMut},
};

use crate::{
    Arena, ArenaBox, Element,
    element::{Drawable, ElementObject},
    window::CURRENT_ELEMENT_ARENA,
};

pub(crate) enum ElementStorage {
    Frame(ArenaBox<dyn ElementObject>),
    Owned(Box<dyn ElementObject>),
}

pub(crate) fn new<E: 'static + Element>(element: E) -> ElementStorage
where
    E::RequestLayoutState: Any,
{
    with_element_arena(|arena| match arena {
        Some(arena) => ElementStorage::Frame(
            arena
                .alloc(|| Drawable::new(element))
                .map(|element| element as &mut dyn ElementObject),
        ),
        None => ElementStorage::Owned(Box::new(Drawable::new(element))),
    })
}

#[inline(never)]
fn with_element_arena_erased(callback: &mut dyn FnMut(Option<&mut Arena>)) {
    let pointer = CURRENT_ELEMENT_ARENA
        .try_with(|current| current.get())
        .expect("cannot access an element arena during thread-local destruction");
    if let Some(pointer) = pointer {
        // SAFETY: the pointer is set only while the owning draw scope is alive.
        let arena = unsafe { &*pointer };
        callback(Some(&mut arena.borrow_mut()));
    } else {
        callback(None);
    }
}

fn with_element_arena<R>(callback: impl FnOnce(Option<&mut Arena>) -> R) -> R {
    let mut callback = Some(callback);
    let mut result = None;
    with_element_arena_erased(&mut |arena| {
        result = Some(callback.take().expect("arena callback runs once")(arena));
    });
    result.expect("arena callback produces a result")
}

impl Deref for ElementStorage {
    type Target = dyn ElementObject;
    fn deref(&self) -> &Self::Target {
        match self {
            Self::Frame(element) => &**element,
            Self::Owned(element) => &**element,
        }
    }
}

impl DerefMut for ElementStorage {
    fn deref_mut(&mut self) -> &mut Self::Target {
        match self {
            Self::Frame(element) => &mut **element,
            Self::Owned(element) => &mut **element,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::rc::Rc;

    use crate::{InteractiveElement, IntoElement, MouseButton, div};

    #[test]
    fn discarded_off_frame_elements_release_captures() {
        let owner = Rc::new(());
        for _ in 0..64 {
            let captured = owner.clone();
            drop(
                div()
                    .on_mouse_down(MouseButton::Left, move |_, _, _| {
                        let _ = &captured;
                    })
                    .into_any_element(),
            );
        }
        assert_eq!(Rc::strong_count(&owner), 1);
    }
}
