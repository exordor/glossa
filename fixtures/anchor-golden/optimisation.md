# Optimisation for neural networks

Training a network means searching for parameters that make the loss small. The loss is a function of millions of parameters, so we cannot inspect it directly; we can only ask how it changes when the parameters move a little.

## Gradient descent

Gradient descent takes a small step against the gradient. The gradient points uphill, so the step goes downhill. The size of the step is the learning rate, and choosing the learning rate is most of the craft.

If the learning rate is too large, the loss jumps around and may grow without bound. If the learning rate is too small, the loss falls so slowly that training never finishes. A good learning rate sits between the two, and it usually changes during training.

Stochastic gradient descent estimates the gradient from a small batch instead of the whole dataset. The estimate is noisy, but it is cheap, and the noise can even help the parameters escape flat regions of the loss.

## Momentum

Momentum keeps a running average of past gradients and steps along that average. When the gradient keeps pointing the same way, the average grows and the steps get longer. When the gradient flips back and forth, the average cancels out and the steps stay short.

A common choice is to keep ninety percent of the old average at each step. With that choice the average remembers roughly the last ten gradients, which smooths the noise from small batches.

Nesterov momentum looks ahead before it computes the gradient. It first moves along the average, then measures the gradient at the new point, which often corrects an overshoot one step earlier than plain momentum.

## Adaptive methods

Adaptive methods give every parameter its own learning rate. Parameters with large, frequent gradients get a smaller learning rate, and parameters with rare gradients get a larger one.

Adam combines momentum with an adaptive learning rate. It keeps a running average of the gradient and a running average of the squared gradient, and divides one by the square root of the other.

Because Adam divides by the square root of a running average, the effective step is roughly the same size for every parameter. This makes Adam forgiving: a learning rate that works for one layer usually works for the others.

Adam is not always better. On some problems plain stochastic gradient descent with momentum reaches a lower loss on held-out data, even though Adam reaches a lower loss on the training data first.

## Learning rate schedules

A schedule changes the learning rate during training. Warmup starts with a small learning rate and raises it over the first few thousand steps, which keeps the early, unstable steps from doing damage.

After warmup, many schedules decay the learning rate. Step decay divides it by ten at fixed points; cosine decay lowers it smoothly to almost zero by the end of training.

The schedule interacts with the batch size. A larger batch gives a less noisy gradient, so a larger learning rate becomes safe, and the warmup can be shorter.

## Normalisation

Normalisation layers rescale activations so that each layer sees inputs of a similar size. Batch normalisation uses statistics from the current batch; layer normalisation uses statistics from a single example.

Layer normalisation does not depend on the batch, so it behaves the same during training and inference. That is one reason transformers use layer normalisation rather than batch normalisation.

## Checking that training works

Before a long run, train on a tiny subset and check that the loss can reach almost zero. If the loss cannot fall even on a tiny subset, the problem is a bug, not the learning rate.

Plot the loss on a log scale. A loss that falls in steps often points to the schedule; a loss that suddenly jumps to a huge value often points to a learning rate that is too large.

```python
for step, batch in enumerate(loader):
    loss = model(batch).loss
    loss.backward()
    optimiser.step()
    optimiser.zero_grad()
```

| Method | Keeps an average | Per-parameter learning rate |
| --- | --- | --- |
| SGD | no | no |
| Momentum | yes | no |
| Adam | yes | yes |
