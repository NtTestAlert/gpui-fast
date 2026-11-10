//! Tests of how retained subtrees record what they read. See
//! [`crate::fast::dependencies`].

use crate::fast::dependencies::merge_sorted;
use std::rc::Rc;

#[test]
fn retained_reads_follow_mounted_children_and_open_windows() {
    use std::cell::Cell;

    use crate::{
        AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render, StyleRefinement,
        Styled as _, TestAppContext, Window, div, px,
    };

    struct Reader {
        shared: Entity<usize>,
        builds: Rc<Cell<usize>>,
    }
    impl Render for Reader {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            self.builds.set(self.builds.get() + 1);
            div().child(self.shared.read(cx).to_string())
        }
    }

    struct Host(Option<Entity<Reader>>);
    impl Render for Host {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().children(self.0.as_ref().map(|child| {
                child
                    .clone()
                    .cached(StyleRefinement::default().w(px(100.)).h(px(20.)))
            }))
        }
    }

    let mut cx = TestAppContext::single();
    let shared = cx.new(|_| 0usize);
    let make_window = |cx: &mut TestAppContext| {
        let builds = Rc::new(Cell::new(0));
        let window = cx.add_window(|_, cx| {
            Host(Some(cx.new(|_| Reader {
                shared: shared.clone(),
                builds: builds.clone(),
            })))
        });
        (window, builds)
    };
    let (first, first_builds) = make_window(&mut cx);
    let (second, second_builds) = make_window(&mut cx);
    cx.run_until_parked();
    let readers = |cx: &TestAppContext| {
        cx.read(|app| {
            app.window_invalidators_by_entity
                .get(&shared.entity_id())
                .map(|windows| windows.len())
        })
    };
    assert_eq!(readers(&cx), Some(2));
    let before = (first_builds.get(), second_builds.get());
    assert!(before.0 > 0 && before.1 > 0);
    for window in [first, second] {
        window.update(&mut cx, |_, _, cx| cx.notify()).unwrap();
    }
    cx.run_until_parked();
    assert_eq!((first_builds.get(), second_builds.get()), before);
    assert_eq!(readers(&cx), Some(2));
    shared.update(&mut cx, |value, cx| {
        *value += 1;
        cx.notify();
    });
    cx.run_until_parked();
    assert!(first_builds.get() > before.0 && second_builds.get() > before.1);

    first
        .update(&mut cx, |host, _, cx| {
            host.0.take();
            cx.notify();
        })
        .unwrap();
    cx.run_until_parked();
    assert_eq!(readers(&cx), Some(1));
    second
        .update(&mut cx, |_, window, _| window.remove_window())
        .unwrap();
    cx.run_until_parked();
    assert_eq!(readers(&cx), None);

    let observed = Rc::new(Cell::new(0));
    let count = observed.clone();
    let _subscription =
        cx.update(|app| app.observe(&shared, move |_, _| count.set(count.get() + 1)));
    shared.update(&mut cx, |_, cx| cx.notify());
    cx.run_until_parked();
    assert_eq!(observed.get(), 1);
    assert_eq!(readers(&cx), None);
}

#[test]
fn merging_sorted_lists_shares_one_that_holds_the_other() {
    let all: Rc<[u32]> = Rc::from([1, 3, 5, 7]);
    let some: Rc<[u32]> = Rc::from([3, 7]);
    let empty: Rc<[u32]> = Rc::from([]);

    assert!(Rc::ptr_eq(&merge_sorted(&all, &some), &all));
    assert!(Rc::ptr_eq(&merge_sorted(&some, &all), &all));
    assert!(Rc::ptr_eq(&merge_sorted(&all, &empty), &all));
    assert!(Rc::ptr_eq(&merge_sorted(&empty, &some), &some));

    let other: Rc<[u32]> = Rc::from([2, 3, 8]);
    assert_eq!(&*merge_sorted(&all, &other), &[1, 2, 3, 5, 7, 8]);
    assert_eq!(&*merge_sorted(&other, &all), &[1, 2, 3, 5, 7, 8]);
}

/// A subtree built again, frame after frame, reading what it read before,
/// takes the list of what it read that it had, rather than a new one.
#[test]
fn a_subtree_built_again_reading_the_same_takes_the_list_it_had() {
    use crate::{
        AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render, TestAppContext,
        Window, div,
    };

    struct Shared(u32);
    struct Reader(Entity<Shared>);
    impl Render for Reader {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            div().child(format!("{}", self.0.read(cx).0))
        }
    }
    struct Readers(Vec<Entity<Reader>>);
    impl Render for Readers {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().children(self.0.iter().cloned())
        }
    }

    let mut cx = TestAppContext::single();
    let window = cx.add_window(|_, cx| {
        let shared = cx.new(|_| Shared(0));
        Readers((0..3).map(|_| cx.new(|_| Reader(shared.clone()))).collect())
    });
    let lists = |cx: &mut TestAppContext| {
        cx.update_window(window.into(), |_, window, cx| {
            // Every reader built again, reading what it read before.
            window.refresh();
            window.draw(cx).clear(cx);
            window
                .rendered_frame
                .retained
                .records
                .iter()
                .filter(|record| record.own_dependencies.entities.len() == 2)
                .map(|record| record.own_dependencies.entities.clone())
                .collect::<Vec<_>>()
        })
        .unwrap()
    };
    let first = lists(&mut cx);
    assert_eq!(first.len(), 3, "each reader reads itself and the model");
    let second = lists(&mut cx);
    assert_eq!(second.len(), 3);
    for (first, second) in first.iter().zip(&second) {
        assert!(
            Rc::ptr_eq(first, second),
            "a subtree built again reading the same should take the list it had"
        );
    }
}
