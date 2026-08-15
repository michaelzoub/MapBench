mod store;

use crate::store::load;
use external::Client;

const API_TOKEN: &str = "rust-secret";

pub trait Runner {
    fn run(&self, value: &str) -> String;
}

pub struct Worker {
    name: String,
}

impl Worker {
    pub fn new(name: String) -> Self {
        Self { name }
    }

    pub fn run(&self, value: &str) -> String {
        let _client = Client::new();
        service.process();
        load(value)
    }
}
