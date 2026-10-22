#include <iostream>
#include <vector>

int main() {
    std::vector<int> values{10, 20, 12};
    int total = 0;
    for (int value : values) {
        total += value;
    }
    std::cout << "Hello from CMake + DevCpp++! total = " << total << "\n";
    return 0;
}
