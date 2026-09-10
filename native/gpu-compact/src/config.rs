//! Explicit, finite experiment modes. Profiling is never enabled implicitly.
pub(crate) struct Config {
    pub software: bool,
    pub deduplicate: bool,
    pub profile: bool,
}

impl Config {
    pub fn parse(args: &[String]) -> Result<Self, String> {
        let software = match args.first().map(String::as_str) {
            Some("--software-test") => true,
            Some("--hardware-test") => false,
            _ => return Err("use --software-test or --hardware-test".into()),
        };
        let mut config = Self {
            software,
            deduplicate: false,
            profile: false,
        };
        for arg in &args[1..] {
            match arg.as_str() {
                "--deduplicate" if !config.deduplicate => config.deduplicate = true,
                "--profile-stages" if !config.profile => config.profile = true,
                _ => return Err("unknown or duplicate experiment option".into()),
            }
        }
        Ok(config)
    }

    pub fn flags(&self) -> i32 {
        i32::from(self.deduplicate) | (i32::from(self.profile) << 1)
    }
}

#[cfg(test)]
mod tests {
    use super::Config;

    fn parse(args: &[&str]) -> Result<Config, String> {
        Config::parse(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn modes_are_explicit_and_bounded() {
        let baseline = parse(&["--software-test"]).unwrap();
        assert!(baseline.software);
        assert_eq!(baseline.flags(), 0);
        assert_eq!(
            parse(&["--hardware-test", "--deduplicate"])
                .unwrap()
                .flags(),
            1
        );
        assert_eq!(
            parse(&["--software-test", "--profile-stages"])
                .unwrap()
                .flags(),
            2
        );
        assert_eq!(
            parse(&["--hardware-test", "--deduplicate", "--profile-stages"])
                .unwrap()
                .flags(),
            3
        );
        for args in [
            vec![],
            vec!["--deduplicate"],
            vec!["--hardware-test", "--software-test"],
            vec!["--software-test", "--deduplicate", "--deduplicate"],
            vec!["--hardware-test", "--profile-stages", "--profile-stages"],
        ] {
            assert!(parse(&args).is_err());
        }
    }
}
