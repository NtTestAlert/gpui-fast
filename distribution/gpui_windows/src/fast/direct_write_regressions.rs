// Modified by NtTestAlert for the GPUI Fast fork.
//! Check the face used for rasterization after a native DrawGlyphRun callback.

use gpui::{PlatformTextSystem, font};

use super::DirectWriteTextSystem;

#[test]
fn shaped_run_keeps_simulated_face() -> anyhow::Result<()> {
    use super::{RendererContext, StringIndexConverter};
    use std::mem::ManuallyDrop;
    use windows::{
        Win32::Graphics::DirectWrite::{
            DWRITE_FONT_SIMULATIONS_OBLIQUE, DWRITE_FONT_STRETCH_NORMAL, DWRITE_GLYPH_OFFSET,
            DWRITE_GLYPH_RUN, DWRITE_GLYPH_RUN_DESCRIPTION, DWRITE_MEASURING_MODE_NATURAL,
            IDWriteFontFace,
        },
        core::{IUnknown, Interface, w},
    };

    let system = DirectWriteTextSystem::new()?;
    let base_id = system.font_id(&font("Arial"))?;
    let mut state = system.state.write();
    let info = &state.fonts[base_id.0];
    let simulated = unsafe {
        info.font_face
            .GetFontFaceReference()?
            .CreateFontFaceWithSimulations(DWRITE_FONT_SIMULATIONS_OBLIQUE)?
    };
    let layout = unsafe {
        let format = system.components.factory.CreateTextFormat(
            &info.font_family_h,
            &info.font_collection,
            info.font_face.GetWeight(),
            info.font_face.GetStyle(),
            DWRITE_FONT_STRETCH_NORMAL,
            14.,
            w!("en-US"),
        )?;
        system
            .components
            .factory
            .CreateTextLayout(&[u16::from(b'A')], &format, 100., 30.)?
    };
    let mut glyph_id = 0;
    unsafe { simulated.GetGlyphIndices(&u32::from('A'), 1, &mut glyph_id)? };
    assert_ne!(glyph_id, 0);
    let face: &IDWriteFontFace = &simulated;
    let offset = DWRITE_GLYPH_OFFSET::default();
    let run = DWRITE_GLYPH_RUN {
        // DrawGlyphRun borrows the face while simulated owns its reference.
        fontFace: ManuallyDrop::new(Some(unsafe { std::ptr::read(face) })),
        fontEmSize: 14.,
        glyphCount: 1,
        glyphIndices: &glyph_id,
        glyphAdvances: &8.,
        glyphOffsets: &offset,
        ..Default::default()
    };
    let description = DWRITE_GLYPH_RUN_DESCRIPTION {
        string: w!("A"),
        stringLength: 1,
        clusterMap: &0,
        ..Default::default()
    };
    let mut runs = Vec::new();
    for _ in 0..2 {
        let mut context = RendererContext {
            text_system: &mut state,
            components: &system.components,
            index_converter: StringIndexConverter::new("A"),
            runs: &mut runs,
            layout: &layout,
            width: 0.,
            fast_requested_font: Some(base_id),
        };
        unsafe {
            system.components.text_renderer.0.DrawGlyphRun(
                Some((&raw mut context).cast()),
                0.,
                0.,
                DWRITE_MEASURING_MODE_NATURAL,
                &run,
                &description,
                None,
            )?;
        }
    }
    assert_eq!(runs.len(), 2);
    assert_eq!(runs[0].font_id, runs[1].font_id);
    let cached = &state.fonts[runs[0].font_id.0].font_face;
    assert_eq!(
        unsafe { cached.GetSimulations() },
        DWRITE_FONT_SIMULATIONS_OBLIQUE
    );
    assert_eq!(cached.cast::<IUnknown>()?, simulated.cast::<IUnknown>()?);
    Ok(())
}
