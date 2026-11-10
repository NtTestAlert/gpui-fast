// Modified by Longbridge for gpui-fast.
//! Preserve the shaped DirectWrite face and reuse its stable raster identity.
// Modified by NtTestAlert from the GPUI DirectWrite implementation.

use gpui::FontId;
use windows::{
    Win32::{
        Foundation::DWRITE_E_NOFONT,
        Graphics::DirectWrite::{
            DWRITE_FONT_AXIS_VALUE, IDWriteFactory5, IDWriteFontFace3, IDWriteFontFace5,
        },
    },
    core::{Error, HSTRING, IUnknown, Interface},
};

use crate::direct_write::{DirectWriteComponents, DirectWriteState, FontInfo, get_name};

fn axis_values(face: &IDWriteFontFace5) -> windows::core::Result<Vec<DWRITE_FONT_AXIS_VALUE>> {
    let count = unsafe { face.GetFontAxisValueCount() } as usize;
    let mut values = vec![DWRITE_FONT_AXIS_VALUE::default(); count];
    if count > 0 {
        unsafe { face.GetFontAxisValues(&mut values)? };
        values.sort_unstable_by_key(|axis| axis.axisTag.0);
    }
    Ok(values)
}

fn equivalent_face_id(
    state: &DirectWriteState,
    factory: &IDWriteFactory5,
    face: &IDWriteFontFace3,
) -> Option<FontId> {
    let Ok(modern) = face.cast::<IDWriteFontFace5>() else {
        let in_factory = |face: &IDWriteFontFace3| unsafe {
            let reference = face.GetFontFaceReference()?;
            factory.CreateFontFaceReference(
                &reference.GetFontFile()?,
                reference.GetFontFaceIndex(),
                reference.GetSimulations(),
            )
        };
        let reference = in_factory(face).ok()?;
        let simulations = unsafe { face.GetSimulations() };
        return state
            .fonts
            .iter()
            .position(|font| {
                (unsafe { font.font_face.GetSimulations() }) == simulations
                    && in_factory(&font.font_face)
                        .is_ok_and(|candidate| unsafe { reference.Equals(&candidate).as_bool() })
            })
            .map(FontId);
    };
    let simulations = unsafe { modern.GetSimulations() };
    let axes = axis_values(&modern).ok()?;
    state
        .fonts
        .iter()
        .position(|font| {
            let candidate = &font.font_face;
            if unsafe {
                candidate.GetSimulations() != simulations || !modern.Equals(candidate).as_bool()
            } {
                return false;
            }
            candidate
                .cast::<IDWriteFontFace5>()
                .and_then(|candidate| axis_values(&candidate))
                .is_ok_and(|other| other == axes)
        })
        .map(FontId)
}

pub(crate) fn raster_id(
    state: &DirectWriteState,
    factory: &IDWriteFactory5,
    face: &IDWriteFontFace3,
    new_id: FontId,
) -> FontId {
    face.cast::<IUnknown>()
        .ok()
        .and_then(|face| state.font_info_cache.get(&face.as_raw().addr()).copied())
        .or_else(|| equivalent_face_id(state, factory, face))
        .unwrap_or(new_id)
}

pub(crate) fn shaped_font_id(
    state: &mut DirectWriteState,
    components: &DirectWriteComponents,
    face: &IDWriteFontFace3,
    locale: &HSTRING,
    requested: Option<FontId>,
) -> windows::core::Result<FontId> {
    let key = face.cast::<IUnknown>()?.as_raw().addr();
    let canonical = if let Some(&id) = state.font_info_cache.get(&key) {
        id
    } else if let Some(id) = equivalent_face_id(state, &components.factory, face) {
        id
    } else {
        let family = get_name(unsafe { face.GetFamilyNames()? }, locale)
            .map_err(|_| Error::new(DWRITE_E_NOFONT, "Missing font family name"))?;
        let collection =
            if unsafe { state.custom_font_collection.GetFontFromFontFace(face) }.is_ok() {
                &state.custom_font_collection
            } else {
                &state.system_font_collection
            };
        let id = FontId(state.fonts.len());
        state.fonts.push(FontInfo {
            font_family_h: HSTRING::from(family.as_str()),
            font_face: face.clone(),
            features: unsafe { components.factory.CreateTypography()? },
            fallbacks: None,
            font_collection: collection.clone(),
        });
        state.font_info_cache.insert(key, id);
        id
    };
    // Keep Fast's number shaping keyed by its request when the actual face agrees.
    Ok(requested
        .filter(|id| {
            state.fonts[id.0]
                .font_face
                .cast::<IUnknown>()
                .ok()
                .and_then(|face| state.font_info_cache.get(&face.as_raw().addr()).copied())
                == Some(canonical)
        })
        .unwrap_or(canonical))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use gpui::{FontFeatures, FontRun, PlatformTextSystem, font, px};
    use windows::{
        Win32::Graphics::DirectWrite::{
            DWRITE_FACTORY_TYPE_ISOLATED, DWRITE_FONT_AXIS_TAG_WEIGHT, DWRITE_FONT_AXIS_VALUE,
            DWRITE_FONT_SIMULATIONS_NONE, DWRITE_FONT_SIMULATIONS_OBLIQUE, DWriteCreateFactory,
            IDWriteFactory3, IDWriteFactory6, IDWriteFontFace3, IDWriteFontFace5,
        },
        core::{HSTRING, IUnknown, Interface},
    };

    use super::{axis_values, shaped_font_id};
    use crate::direct_write::DirectWriteTextSystem;

    #[test]
    fn feature_variant_keeps_requested_id_for_number_shaping() -> anyhow::Result<()> {
        let system = DirectWriteTextSystem::new(None)?;
        let mut font = font("Consolas");
        let base = system.font_id(&font)?;
        font.features = FontFeatures(Arc::new(vec![("tnum".into(), 1)]));
        let tabular = system.font_id(&font)?;
        assert_ne!(base, tabular);
        let text = "0123456789";
        let line = system.layout_line(
            text,
            px(14.),
            &[FontRun {
                len: text.len(),
                font_id: tabular,
            }],
        );
        assert!(!line.runs.is_empty());
        assert!(line.runs.iter().all(|run| run.font_id == tabular));
        let mixed = "12 😀";
        let mixed_line = system.layout_line(
            mixed,
            px(14.),
            &[FontRun {
                len: mixed.len(),
                font_id: tabular,
            }],
        );
        assert!(mixed_line.runs.iter().any(|run| run.font_id == tabular));
        assert!(mixed_line.runs.iter().any(|run| run.font_id != tabular));
        Ok(())
    }

    #[test]
    fn shaped_simulated_face_keeps_identity_and_reuses_aliases() -> anyhow::Result<()> {
        let system = DirectWriteTextSystem::new(None)?;
        let base_id = system.font_id(&font("Arial"))?;
        let mut state = system.state.write();
        let simulated = unsafe {
            state.fonts[base_id.0]
                .font_face
                .GetFontFaceReference()?
                .CreateFontFaceWithSimulations(DWRITE_FONT_SIMULATIONS_OBLIQUE)?
        };
        let locale = HSTRING::from("en-US");
        let id = shaped_font_id(
            &mut state,
            &system.components,
            &simulated,
            &locale,
            Some(base_id),
        )?;
        assert_ne!(id, base_id);
        assert_eq!(
            state.fonts[id.0].font_face.cast::<IUnknown>()?,
            simulated.cast::<IUnknown>()?
        );
        assert_eq!(
            unsafe { state.fonts[id.0].font_face.GetSimulations() },
            DWRITE_FONT_SIMULATIONS_OBLIQUE
        );
        let factory: IDWriteFactory3 =
            unsafe { DWriteCreateFactory(DWRITE_FACTORY_TYPE_ISOLATED)? };
        let reference = unsafe { simulated.GetFontFaceReference()? };
        let alias = unsafe {
            factory
                .CreateFontFaceReference(
                    &reference.GetFontFile()?,
                    reference.GetFontFaceIndex(),
                    reference.GetSimulations(),
                )?
                .CreateFontFace()?
        };
        assert_ne!(simulated.cast::<IUnknown>()?, alias.cast::<IUnknown>()?);
        let count = state.fonts.len();
        for _ in 0..8 {
            assert_eq!(
                shaped_font_id(&mut state, &system.components, &alias, &locale, None)?,
                id
            );
            assert_eq!(state.fonts.len(), count);
        }
        Ok(())
    }

    #[test]
    fn simulated_and_variable_instances_keep_distinct_ids() -> anyhow::Result<()> {
        let system = DirectWriteTextSystem::new(None)?;
        if system.components.factory.cast::<IDWriteFactory6>().is_err() {
            return Ok(());
        }
        let family = system.font_id(&font("Bahnschrift"))?;
        let mut state = system.state.write();
        let face = state.fonts[family.0].font_face.cast::<IDWriteFontFace5>()?;
        let resource = unsafe { face.GetFontResource()? };
        let instance = |weight, simulations| -> anyhow::Result<IDWriteFontFace3> {
            let axes = [DWRITE_FONT_AXIS_VALUE {
                axisTag: DWRITE_FONT_AXIS_TAG_WEIGHT,
                value: weight,
            }];
            let face = unsafe { resource.CreateFontFace(simulations, &axes)? };
            assert!(axis_values(&face)?.contains(&axes[0]));
            Ok(face.cast()?)
        };
        let oblique = instance(550., DWRITE_FONT_SIMULATIONS_OBLIQUE)?;
        let upright = instance(550., DWRITE_FONT_SIMULATIONS_NONE)?;
        let heavier = instance(650., DWRITE_FONT_SIMULATIONS_NONE)?;
        let locale = HSTRING::from("en-US");
        let mut resolve =
            |face| shaped_font_id(&mut state, &system.components, face, &locale, None);
        let oblique_id = resolve(&oblique)?;
        let upright_id = resolve(&upright)?;
        let heavier_id = resolve(&heavier)?;
        assert_ne!(oblique_id, upright_id);
        assert_ne!(upright_id, heavier_id);
        assert_ne!(oblique_id, heavier_id);
        assert_eq!(resolve(&oblique)?, oblique_id);
        assert_eq!(resolve(&upright)?, upright_id);
        assert_eq!(resolve(&heavier)?, heavier_id);
        Ok(())
    }
}
