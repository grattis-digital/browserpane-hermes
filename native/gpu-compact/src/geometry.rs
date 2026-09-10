#[derive(Clone, Copy)]
pub(crate) struct Geometry {
    pub width: usize,
    pub height: usize,
}

impl Geometry {
    pub fn new(width: usize, height: usize) -> Result<Self, String> {
        if width == 0 || width > 1920 || height == 0 || height > 1080 {
            return Err("unsupported bounded geometry".into());
        }
        Ok(Self { width, height })
    }

    pub fn columns(self) -> usize {
        self.width.div_ceil(32)
    }
    pub fn tiles(self) -> usize {
        self.columns() * self.height.div_ceil(32)
    }
    pub fn pixels(self) -> usize {
        self.width * self.height
    }

    pub fn source(self, x: usize, y: usize, delta: (i32, i32)) -> Option<usize> {
        let x = i64::try_from(x).ok()? + i64::from(delta.0);
        let y = i64::try_from(y).ok()? + i64::from(delta.1);
        (x >= 0 && x < self.width as i64 && y >= 0 && y < self.height as i64)
            .then(|| y as usize * self.width + x as usize)
    }
}

#[cfg(test)]
mod tests {
    use super::Geometry;

    #[test]
    fn checked_bounds_and_partial_tiles() {
        assert!(Geometry::new(0, 720).is_err());
        assert!(Geometry::new(1921, 720).is_err());
        let g = Geometry::new(33, 35).unwrap();
        assert_eq!(g.tiles(), 4);
        assert_eq!(g.source(32, 34, (0, 0)), Some(1154));
        assert_eq!(g.source(32, 34, (1, 0)), None);
        assert_eq!(g.source(0, 0, (-1, 0)), None);
        assert_eq!(g.source(0, 0, (i32::MIN, i32::MAX)), None);
    }
}
