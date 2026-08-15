package service

import (
	"fmt"
	"example.com/mapbench/store"
)

var apiToken = "go-secret"

type Worker struct {
	name string
}

type Runner interface {
	Run(value string) string
}

func NewWorker(name string) *Worker {
	return &Worker{name: name}
}

func (worker *Worker) Run(value string) string {
	fmt.Println(value)
	result := store.Load(value)
	service.Process(result)
	return result
}
