// Modified by NtTestAlert for the GPUI Fast fork.
// Modified by Longbridge for gpui-fast.
//! Which windows each entity's notifications invalidate, kept up to date
//! after every draw by touching only the entities a window started or
//! stopped drawing.

use std::collections::hash_map::Entry;

use collections::FxHashSet;
use smallvec::SmallVec;

use crate::{AnyWindowHandle, App, EntityId, WindowId, WindowInvalidator};

#[cfg(any(test, feature = "test-support"))]
impl App {
    /// Number of entity keys in the render dependency index.
    pub fn tracked_render_entity_count(&self) -> usize {
        self.window_invalidators_by_entity.len()
    }
}

pub(crate) fn remove_window_entity(cx: &mut App, entity: EntityId, window: WindowId) {
    if let Entry::Occupied(mut entry) = cx.window_invalidators_by_entity.entry(entity) {
        let windows = entry.get_mut();
        windows.remove(&window);
        if windows.is_empty() {
            entry.remove();
        }
    }
}

pub(crate) fn window_invalidators(cx: &App, entity: EntityId) -> SmallVec<[WindowInvalidator; 2]> {
    cx.window_invalidators_by_entity
        .get(&entity)
        .into_iter()
        .flat_map(|windows| windows.values().cloned())
        .collect()
}

/// Records that the window drew `entities` and nothing else, as
/// [`App::record_entities_accessed`] does.
///
/// Upstream removed the window's invalidator from every entity it tracked
/// before, then inserted it again for every entity it drew: four map
/// operations and a reference count round trip per entity, every frame,
/// though most frames draw the entities the last one did. A window's
/// invalidator never changes and an entity's entry for the window exists
/// exactly while the window tracks it (only this function, the release of
/// the entity and the window's removal change either), so only entities that
/// left the set lose it, and only those that entered gain it. Each entity
/// drawn still makes the window its current window, as upstream's loop did.
pub(crate) fn record_entities_accessed(
    cx: &mut App,
    window_handle: AnyWindowHandle,
    invalidator: WindowInvalidator,
    entities: &FxHashSet<EntityId>,
) {
    let window_id = window_handle.id;
    let mut tracked_entities = std::mem::take(cx.tracked_entities.entry(window_id).or_default());
    for entity in tracked_entities.iter() {
        if !entities.contains(entity) {
            remove_window_entity(cx, *entity, window_id);
        }
    }
    for entity in entities.iter() {
        if !tracked_entities.contains(entity) {
            cx.window_invalidators_by_entity
                .entry(*entity)
                .or_default()
                .insert(window_id, invalidator.clone());
        }
        cx.current_window_by_entity.insert(*entity, window_id);
    }
    tracked_entities.clear();
    tracked_entities.extend(entities.iter().copied());
    cx.tracked_entities.insert(window_id, tracked_entities);
}
