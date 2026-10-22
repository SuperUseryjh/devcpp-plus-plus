#include <iostream>
#include <vector>

#include "math.h"

int main() {
    std::vector<int> values{1, 2, 3};
    int total = 0;
    for (int value : values) {
        total = add(total, value);
    }
    std::cout << "Hello from DevCpp++! total = " << total << "\n";
    return 0;
}
