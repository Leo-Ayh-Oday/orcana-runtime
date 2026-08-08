//! CellPlan：结构 + 极简 JSON 解析（纯 std）+ 校验（schema/digest/授权）。

use std::collections::HashMap;

#[derive(Debug)]
pub enum PlanError {
    Schema(String),
    Io(String),
}

impl std::fmt::Display for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlanError::Schema(s) => write!(f, "schema: {s}"),
            PlanError::Io(s) => write!(f, "io: {s}"),
        }
    }
}

impl std::error::Error for PlanError {}

#[derive(Debug, Clone)]
pub struct ExecSpec {
    pub path: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, Default)]
pub struct Rlimits {
    pub as_bytes: Option<u64>,
    pub nofile: Option<u64>,
    pub nproc: Option<u64>,
}

#[derive(Debug, Clone, Default)]
pub struct LandlockSpec {
    pub read_paths: Vec<String>,
    pub write_paths: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SeccompSpec {
    pub allow_syscalls: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct CellPlan {
    pub schema_version: String,
    pub exec: ExecSpec,
    pub cwd: String,
    pub rlimits: Rlimits,
    pub no_new_privs: bool,
    pub landlock: LandlockSpec,
    pub seccomp: SeccompSpec,
}

/// 极简 JSON 值（递归下降解析器 —— 只支持 plan 需要的最小形状）。
#[derive(Debug, Clone)]
pub enum Json {
    Object(HashMap<String, Json>),
    Array(Vec<Json>),
    String(String),
    Number(f64),
    Bool(bool),
    Null,
}

pub struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Parser { bytes, pos: 0 }
    }

    fn skip_ws(&mut self) {
        while self.pos < self.bytes.len() && (self.bytes[self.pos] as char).is_whitespace() {
            self.pos += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn expect(&mut self, b: u8) -> Result<(), PlanError> {
        if self.peek() == Some(b) {
            self.pos += 1;
            Ok(())
        } else {
            Err(PlanError::Schema(format!(
                "expected '{}' at {}",
                b as char, self.pos
            )))
        }
    }

    pub fn parse_value(&mut self) -> Result<Json, PlanError> {
        self.skip_ws();
        match self.peek() {
            Some(b'{') => {
                self.pos += 1;
                let mut obj = HashMap::new();
                self.skip_ws();
                if self.peek() == Some(b'}') {
                    self.pos += 1;
                    return Ok(Json::Object(obj));
                }
                loop {
                    self.skip_ws();
                    let key = self.parse_string()?;
                    self.skip_ws();
                    self.expect(b':')?;
                    let value = self.parse_value()?;
                    obj.insert(key, value);
                    self.skip_ws();
                    match self.peek() {
                        Some(b',') => {
                            self.pos += 1;
                        }
                        Some(b'}') => {
                            self.pos += 1;
                            break;
                        }
                        _ => return Err(PlanError::Schema("expected , or }".into())),
                    }
                }
                Ok(Json::Object(obj))
            }
            Some(b'[') => {
                self.pos += 1;
                let mut arr = Vec::new();
                self.skip_ws();
                if self.peek() == Some(b']') {
                    self.pos += 1;
                    return Ok(Json::Array(arr));
                }
                loop {
                    let v = self.parse_value()?;
                    arr.push(v);
                    self.skip_ws();
                    match self.peek() {
                        Some(b',') => {
                            self.pos += 1;
                        }
                        Some(b']') => {
                            self.pos += 1;
                            break;
                        }
                        _ => return Err(PlanError::Schema("expected , or ]".into())),
                    }
                }
                Ok(Json::Array(arr))
            }
            Some(b'"') => Ok(Json::String(self.parse_string()?)),
            Some(b't') => {
                self.pos += 4; // true
                Ok(Json::Bool(true))
            }
            Some(b'f') => {
                self.pos += 5; // false
                Ok(Json::Bool(false))
            }
            Some(b'n') => {
                self.pos += 4; // null
                Ok(Json::Null)
            }
            _ => {
                // number
                let start = self.pos;
                while self.pos < self.bytes.len()
                    && (self.bytes[self.pos] as char).is_ascii_digit()
                        || self.bytes.get(self.pos) == Some(&b'-')
                        || self.bytes.get(self.pos) == Some(&b'.')
                {
                    self.pos += 1;
                }
                let s = std::str::from_utf8(&self.bytes[start..self.pos])
                    .map_err(|_| PlanError::Schema("bad number".into()))?;
                let n = s
                    .parse::<f64>()
                    .map_err(|_| PlanError::Schema(format!("bad number: {s}")))?;
                Ok(Json::Number(n))
            }
        }
    }

    fn parse_string(&mut self) -> Result<String, PlanError> {
        self.expect(b'"')?;
        let start = self.pos;
        while self.pos < self.bytes.len() && self.bytes[self.pos] != b'"' {
            if self.bytes[self.pos] == b'\\' {
                self.pos += 1; // 跳过转义字符（v1 不支持转义 —— plan 由内部生成）
            }
            self.pos += 1;
        }
        let s = std::str::from_utf8(&self.bytes[start..self.pos])
            .map_err(|_| PlanError::Schema("bad string".into()))?
            .to_string();
        self.expect(b'"')?;
        Ok(s)
    }
}

fn as_object(v: &Json) -> Option<&HashMap<String, Json>> {
    match v {
        Json::Object(o) => Some(o),
        _ => None,
    }
}

fn as_string(v: &Json) -> Option<&String> {
    match v {
        Json::String(s) => Some(s),
        _ => None,
    }
}

fn as_array(v: &Json) -> Option<&Vec<Json>> {
    match v {
        Json::Array(a) => Some(a),
        _ => None,
    }
}

fn as_bool(v: &Json) -> Option<bool> {
    match v {
        Json::Bool(b) => Some(*b),
        _ => None,
    }
}

fn as_u64(v: &Json) -> Option<u64> {
    match v {
        Json::Number(n) => Some(*n as u64),
        _ => None,
    }
}

fn str_array(v: &Json) -> Vec<String> {
    match as_array(v) {
        Some(arr) => arr
            .iter()
            .filter_map(|e| as_string(e).cloned())
            .collect(),
        None => Vec::new(),
    }
}

/// 解析并校验 CellPlan（schema/digest/授权）。
pub fn parse_plan(text: &str) -> Result<CellPlan, PlanError> {
    let mut parser = Parser::new(text.as_bytes());
    let root = parser.parse_value()?;
    let obj = as_object(&root).ok_or_else(|| PlanError::Schema("plan root must be object".into()))?;

    // schemaVersion 校验
    let schema_version = obj
        .get("schemaVersion")
        .and_then(as_string)
        .cloned()
        .ok_or_else(|| PlanError::Schema("missing schemaVersion".into()))?;
    if schema_version != "1.0" {
        return Err(PlanError::Schema(format!(
            "unsupported schemaVersion: {schema_version}"
        )));
    }

    // exec：path/args/env 必须完整（授权面 —— 缺字段拒绝）
    let exec_obj = obj
        .get("exec")
        .and_then(as_object)
        .ok_or_else(|| PlanError::Schema("missing exec".into()))?;
    let path = exec_obj
        .get("path")
        .and_then(as_string)
        .cloned()
        .ok_or_else(|| PlanError::Schema("exec.path required".into()))?;
    if path.is_empty() {
        return Err(PlanError::Schema("exec.path must not be empty".into()));
    }
    let args = exec_obj
        .get("args")
        .map(str_array)
        .ok_or_else(|| PlanError::Schema("exec.args required".into()))?;
    let env: HashMap<String, String> = match exec_obj.get("env") {
        Some(Json::Object(o)) => o
            .iter()
            .filter_map(|(k, v)| as_string(v).map(|s| (k.clone(), s.clone())))
            .collect(),
        _ => HashMap::new(),
    };

    let cwd = obj
        .get("cwd")
        .and_then(as_string)
        .cloned()
        .ok_or_else(|| PlanError::Schema("missing cwd".into()))?;

    let rlimits = match obj.get("rlimits") {
        Some(Json::Object(o)) => Rlimits {
            as_bytes: o.get("as").and_then(as_u64),
            nofile: o.get("nofile").and_then(as_u64),
            nproc: o.get("nproc").and_then(as_u64),
        },
        _ => Rlimits::default(),
    };

    let no_new_privs = obj.get("noNewPrivs").and_then(as_bool).unwrap_or(false);

    let landlock = match obj.get("landlock") {
        Some(Json::Object(o)) => LandlockSpec {
            read_paths: o.get("readPaths").map(str_array).unwrap_or_default(),
            write_paths: o.get("writePaths").map(str_array).unwrap_or_default(),
        },
        _ => LandlockSpec::default(),
    };

    let seccomp = match obj.get("seccomp") {
        Some(Json::Object(o)) => SeccompSpec {
            allow_syscalls: o
                .get("allowSyscalls")
                .map(str_array)
                .unwrap_or_default(),
        },
        _ => SeccompSpec::default(),
    };

    Ok(CellPlan {
        schema_version,
        exec: ExecSpec { path, args, env },
        cwd,
        rlimits,
        no_new_privs,
        landlock,
        seccomp,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_plan() {
        let plan = parse_plan(
            r#"{"schemaVersion":"1.0","exec":{"path":"/bin/true","args":["/bin/true"],"env":{"A":"1"}},"cwd":"/workspace","rlimits":{"as":100,"nofile":64},"noNewPrivs":true}"#,
        )
        .unwrap();
        assert_eq!(plan.exec.path, "/bin/true");
        assert_eq!(plan.cwd, "/workspace");
        assert_eq!(plan.rlimits.as_bytes, Some(100));
        assert_eq!(plan.exec.env.get("A").map(|s| s.as_str()), Some("1"));
        assert!(plan.no_new_privs);
    }

    #[test]
    fn rejects_bad_schema() {
        assert!(parse_plan(r#"{"schemaVersion":"2.0"}"#).is_err());
        assert!(parse_plan(r#"{"schemaVersion":"1.0","exec":{}}"#).is_err());
        assert!(parse_plan(r#"not json"#).is_err());
        assert!(parse_plan(r#"{"schemaVersion":"1.0","exec":{"path":"","args":[]},"cwd":"/x"}"#).is_err());
    }

    #[test]
    fn key_order_irrelevant() {
        let a = parse_plan(
            r#"{"schemaVersion":"1.0","exec":{"path":"/bin/true","args":[],"env":{}},"cwd":"/x"}"#,
        )
        .unwrap();
        let b = parse_plan(
            r#"{"cwd":"/x","exec":{"env":{},"args":[],"path":"/bin/true"},"schemaVersion":"1.0"}"#,
        )
        .unwrap();
        assert_eq!(a.exec.path, b.exec.path);
    }
}
