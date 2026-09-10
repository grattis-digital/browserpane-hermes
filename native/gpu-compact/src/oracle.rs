use crate::geometry::Geometry;

pub(crate) fn fixture(g: Geometry, scene: i32, frame: u32) -> Vec<u32> {
    (0..g.pixels())
        .map(|index| {
            let x = (index % g.width) as u32;
            let py = (index / g.width) as u32;
            let y = if [2, 5, 6, 8].contains(&scene) && py >= 48 {
                py + frame * 31
            } else {
                py
            };
            let mut value = (x * 13 + y * 37) ^ ((x / 11) * 971 + (y / 7) * 97);
            if scene == 1 && (31..55).contains(&x) && (63..87).contains(&y) {
                value ^= frame * 0x13579;
            }
            if scene == 3 {
                value ^= frame * 0x91357;
            }
            if scene == 4 && index == g.pixels() - 1 {
                value ^= frame;
            }
            if scene == 6 && (400..451).contains(&x) && (180..231).contains(&py) {
                value = 0x716251;
            }
            let widget_x = 320 + (frame * 7) % 128;
            if scene == 8 && (widget_x..widget_x + 51).contains(&x) && (180..231).contains(&py) {
                value = 0x716251 ^ (frame * 0x13579);
            }
            if scene == 9 {
                value = if x % 32 == 0 && y % 32 == 16 {
                    frame * 0x13579
                } else {
                    0xffffff
                };
            }
            0xff000000 | (value & 0xffffff)
        })
        .collect()
}

/// Validate metadata BEFORE indexing payload/history. Reconstruction always
/// reads the immutable old frame, so overlapping scroll moves cannot corrupt it.
pub(crate) fn reconstruct(
    g: Geometry,
    previous: &[u32],
    checkpoint: &[u32],
    header: &[u32],
    payload: &[u32],
    valid: bool,
) -> Result<Vec<u32>, String> {
    if previous.len() != g.pixels()
        || checkpoint.len() != g.pixels()
        || header.len() != 3 * g.tiles() + 1
    {
        return Err("wrong geometry or header size".into());
    }
    let count = header[0] as usize;
    if count > g.tiles() || payload.len() != count * 1024 {
        return Err("wrong payload size".into());
    }
    validate_slots(&header[1..=g.tiles()], count, valid)?;
    if header[1 + 2 * g.tiles()..].iter().any(|&bank| bank > 1) {
        return Err("invalid cache generation".into());
    }
    (0..g.pixels())
        .map(|index| {
            let (x, y) = (index % g.width, index / g.width);
            let tile = (y / 32) * g.columns() + x / 32;
            let command = header[1 + tile];
            let dy = header[1 + g.tiles() + tile] as i32;
            let bank = header[1 + 2 * g.tiles() + tile];
            match command {
                0 => Ok(previous[index]),
                1 => g
                    .source(x, y, (0, dy))
                    .map(|source| {
                        if bank == 0 {
                            previous[source]
                        } else {
                            checkpoint[source]
                        }
                    })
                    .ok_or_else(|| "out-of-bounds move".into()),
                slot => Ok(payload[(slot as usize - 2) * 1024 + (y % 32) * 32 + x % 32]),
            }
        })
        .collect()
}

fn validate_slots(commands: &[u32], count: usize, valid: bool) -> Result<(), String> {
    let mut seen = vec![false; count];
    for &command in commands {
        if command < 2 {
            if !valid {
                return Err("reuse without history".into());
            }
        } else {
            let slot = command as usize - 2;
            if slot >= count || seen[slot] {
                return Err("invalid or duplicated slot".into());
            }
            seen[slot] = true;
        }
    }
    if seen.iter().any(|value| !value) {
        return Err("missing packed slot".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bad_metadata_and_missing_history() {
        let g = Geometry::new(1, 1).unwrap();
        for header in [
            vec![1, 3, 0, 0],
            vec![0, 2, 0, 0],
            vec![2, 2, 0, 0],
            vec![1, 0, 0, 0],
        ] {
            assert!(reconstruct(g, &[7], &[9], &header, &[0; 1024], true).is_err());
        }
        assert!(reconstruct(g, &[7], &[9], &[0, 0, 0, 0], &[], false).is_err());
        assert!(reconstruct(g, &[7], &[9], &[0, 1, 1, 0], &[], true).is_err());
        assert!(reconstruct(g, &[7], &[9], &[0, 1, 0, 2], &[], true).is_err());
        assert_eq!(
            reconstruct(g, &[7], &[9], &[0, 0, 0, 0], &[], true).unwrap(),
            vec![7]
        );
        assert_eq!(
            reconstruct(g, &[7], &[9], &[0, 1, 0, 1], &[], true).unwrap(),
            vec![9]
        );
    }

    #[test]
    fn overlapping_moves_read_immutable_history() {
        let g = Geometry::new(32, 96).unwrap();
        let old: Vec<u32> = (0..3072).collect();
        let result = reconstruct(
            g,
            &old,
            &old,
            &[1, 1, 1, 2, 32, 32, 0, 0, 0, 0],
            &[99; 1024],
            true,
        )
        .unwrap();
        assert_eq!(&result[..2048], &old[1024..]);
        assert!(result[2048..].iter().all(|value| *value == 99));
    }

    #[test]
    fn rejects_duplicate_slots() {
        let g = Geometry::new(64, 32).unwrap();
        assert!(
            reconstruct(
                g,
                &vec![0; 2048],
                &vec![0; 2048],
                &[2, 2, 2, 0, 0, 0, 0],
                &vec![0; 2048],
                true
            )
            .is_err()
        );
    }
}
